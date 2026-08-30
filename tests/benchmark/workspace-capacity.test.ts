import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createTestHarness, type TestHarness } from '../e2e/harness';
import {
	createCollection,
	createDocument,
	createRecord,
	getRecordYText,
	listDocuments
} from '$lib/data/records';
import { plainText, yTextToRichText } from '$lib/data/richtext';
import { closeDb, getSnapshotStore } from '$lib/server/store';
import {
	flush,
	resetWorkspaceStoreForTests,
	resolveWorkspaceContext
} from '$lib/server/workspace-store';
import type { ActorId, PropertyDefinition } from '$lib/data/types';

const human: ActorId = { kind: 'human', userId: 'benchmark-seed' };

type Profile = {
	documents: number;
	blocksPerDocument: number;
	collections: number;
	rowsPerCollection: number;
	clients: number;
	mcpWrites: number;
};

const PROFILES: Record<string, Profile> = {
	// Bounded enough for CI, while resembling a small working knowledgebase.
	daily: {
		documents: 12,
		blocksPerDocument: 16,
		collections: 3,
		rowsPerCollection: 40,
		clients: 3,
		mcpWrites: 12
	},
	// Run manually before changes that affect the global Phase-0 workspace.
	large: {
		documents: 120,
		blocksPerDocument: 24,
		collections: 8,
		rowsPerCollection: 400,
		clients: 8,
		mcpWrites: 80
	}
};

function percentile(values: number[], fraction: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

function parseMcpText<T>(result: unknown): T {
	const response = result as { content?: Array<{ text?: string }>; isError?: boolean };
	if (response.isError) throw new Error(response.content?.[0]?.text ?? 'MCP tool failed');
	return JSON.parse(response.content?.[0]?.text ?? '') as T;
}

describe('CRDT workspace capacity baseline (issue #31)', () => {
	let harness: TestHarness;

	beforeEach(async () => {
		harness = await createTestHarness();
	});

	afterEach(async () => {
		await harness.cleanup();
	});

	it('measures the real global-workspace transport envelope and a document-shard projection', async () => {
		const profileName = process.env.COMPENDIUM_BENCHMARK_PROFILE ?? 'daily';
		const profile = PROFILES[profileName];
		if (!profile) throw new Error(`Unknown benchmark profile: ${profileName}`);

		const seedClient = harness.getYjsClient();
		const schema: PropertyDefinition[] = [
			{ key: 'title', label: 'Title', type: 'text' },
			{
				key: 'status',
				label: 'Status',
				type: 'select',
				options: [
					{ id: 'idea', label: 'Idea' },
					{ id: 'ready', label: 'Ready' },
					{ id: 'done', label: 'Done' }
				]
			}
		];
		const documentIds: string[] = [];
		const blockIds: string[] = [];

		// Fixture seeding is intentionally direct Yjs data creation. The measured
		// workload below uses the public MCP and WebSocket transports; keeping
		// setup outside that window makes the profile reproducible and focused.
		seedClient.doc.transact(() => {
			for (let documentIndex = 0; documentIndex < profile.documents; documentIndex += 1) {
				const document = createDocument(seedClient.doc, {
					title: `Benchmark document ${documentIndex + 1}`
				});
				documentIds.push(document.id);
				for (let blockIndex = 0; blockIndex < profile.blocksPerDocument; blockIndex += 1) {
					const block = createRecord(
						seedClient.doc,
						{ parentId: document.id, blockType: 'paragraph' },
						human
					);
					getRecordYText(seedClient.doc, block.id)?.insert(
						0,
						`Seed ${documentIndex + 1}.${blockIndex + 1}: durable workspace context. `
					);
					blockIds.push(block.id);
				}
			}
			for (let collectionIndex = 0; collectionIndex < profile.collections; collectionIndex += 1) {
				const collection = createCollection(seedClient.doc, {
					title: `Benchmark collection ${collectionIndex + 1}`,
					schema
				});
				for (let rowIndex = 0; rowIndex < profile.rowsPerCollection; rowIndex += 1) {
					createRecord(
						seedClient.doc,
						{
							parentId: collection.id,
							properties: {
								title: { type: 'text', value: `Row ${collectionIndex + 1}.${rowIndex + 1}` },
								status: { type: 'select', value: rowIndex % 3 === 0 ? 'ready' : 'idea' }
							}
						},
						human
					);
				}
			}
		});

		await harness.waitForCondition(() => getRecordYText(seedClient.doc, blockIds[0]) !== undefined);
		const globalStateBytes = Y.encodeStateAsUpdate(seedClient.doc).byteLength;

		const eventLoop = monitorEventLoopDelay({ resolution: 10 });
		eventLoop.enable();
		const heapBefore = process.memoryUsage().heapUsed;
		const cpuBefore = process.cpuUsage();

		const peers = Array.from({ length: profile.clients }, () => harness.getYjsClient());
		const initialSyncStart = performance.now();
		await Promise.all(
			peers.map((peer) =>
				harness.waitForCondition(
					() => peer.provider.synced && getRecordYText(peer.doc, blockIds[0]) !== undefined,
					{
						timeoutMs: 20_000
					}
				)
			)
		);
		const initialSyncMs = performance.now() - initialSyncStart;
		const initialSyncBytes = peers.reduce((total, peer) => total + peer.traffic.receivedBytes, 0);

		for (const peer of peers) peer.traffic.reset();
		const writer = peers[0];
		const fanoutStart = performance.now();
		const writerText = getRecordYText(writer.doc, blockIds[0]);
		expect(writerText).toBeDefined();
		const fanoutMarker = `Human fan-out mutation ${Date.now()}.`;
		writer.doc.transact(() => writerText?.insert(writerText.length, ` ${fanoutMarker}`));
		await Promise.all(
			peers.slice(1).map((peer) =>
				harness.waitForCondition(() => {
					const text = getRecordYText(peer.doc, blockIds[0]);
					return text ? plainText(yTextToRichText(text)).includes(fanoutMarker) : false;
				})
			)
		);
		// The peer state can converge before ws emits its frame accounting callback
		// in the same Node turn. Let that callback drain before recording bytes.
		await new Promise((resolve) => setTimeout(resolve, 25));
		const fanoutLatencyMs = performance.now() - fanoutStart;
		const fanoutBytes = peers
			.slice(1)
			.reduce((total, peer) => total + peer.traffic.receivedBytes, 0);

		const { token } = harness.createToken({
			clientLabel: 'Capacity benchmark MCP agent',
			allowedDocumentIds: documentIds,
			allowedCollectionIds: []
		});
		const mcp = await harness.getMcpClient(token);
		const mcpLatencies: number[] = [];
		for (let writeIndex = 0; writeIndex < profile.mcpWrites; writeIndex += 1) {
			const blockId = blockIds[writeIndex % blockIds.length];
			const start = performance.now();
			const hold = await mcp.callTool({
				name: 'hold_records',
				arguments: { recordIds: [blockId] }
			});
			expect(parseMcpText<{ granted: string[] }>(hold).granted).toContain(blockId);
			await mcp.callTool({
				name: 'write_record',
				arguments: { recordId: blockId, markdown: `MCP benchmark revision ${writeIndex + 1}` }
			});
			await harness.waitForCondition(() => {
				const text = getRecordYText(peers[0].doc, blockId);
				return text
					? plainText(yTextToRichText(text)).includes(`MCP benchmark revision ${writeIndex + 1}`)
					: false;
			});
			mcpLatencies.push(performance.now() - start);
		}

		await flush();
		const snapshot = getSnapshotStore('default', 'default').loadLatest();
		expect(snapshot).not.toBeNull();
		const snapshotBytes = snapshot?.byteLength ?? 0;
		const restartStart = performance.now();
		closeDb();
		resetWorkspaceStoreForTests();
		const restored = resolveWorkspaceContext();
		const restartMs = performance.now() - restartStart;
		const restoredStateBytes = Y.encodeStateAsUpdate(restored.doc).byteLength;
		eventLoop.disable();

		// A controlled state-size projection: one document's records in their own
		// Y.Doc. It is not a replacement for #113's shard-aware transport; it
		// quantifies the current global blast radius that #112 is intended to fix.
		const projectedDocument = new Y.Doc();
		const projectionDocument = createDocument(projectedDocument, { title: 'Projected document' });
		for (let index = 0; index < profile.blocksPerDocument; index += 1) {
			const block = createRecord(projectedDocument, { parentId: projectionDocument.id }, human);
			getRecordYText(projectedDocument, block.id)?.insert(0, `Projected block ${index + 1}.`);
		}
		const projectedDocumentStateBytes = Y.encodeStateAsUpdate(projectedDocument).byteLength;
		projectedDocument.destroy();

		const result = {
			profile: profileName,
			fixture: profile,
			globalStateBytes,
			initialSync: { totalBytes: initialSyncBytes, durationMs: Number(initialSyncMs.toFixed(1)) },
			fanout: { receiverBytes: fanoutBytes, durationMs: Number(fanoutLatencyMs.toFixed(1)) },
			mcpWriteLatency: {
				p50Ms: Number(percentile(mcpLatencies, 0.5).toFixed(1)),
				p95Ms: Number(percentile(mcpLatencies, 0.95).toFixed(1))
			},
			snapshotBytes,
			restartMs: Number(restartMs.toFixed(1)),
			restoredStateBytes,
			process: {
				heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
				cpuUserMicros: process.cpuUsage(cpuBefore).user,
				eventLoopP99Ms: Number((eventLoop.percentile(99) / 1e6).toFixed(2))
			},
			shardProjection: { oneDocumentStateBytes: projectedDocumentStateBytes }
		};
		console.log(`CRDT_CAPACITY_RESULT ${JSON.stringify(result)}`);

		// Conservative daily-workspace guardrails. Larger profiles are reporting
		// runs, not CI gates, until #24 defines user-facing latency SLOs.
		if (profileName === 'daily') {
			expect(initialSyncBytes).toBeLessThan(2 * 1024 * 1024);
			expect(initialSyncMs).toBeLessThan(2_000);
			expect(percentile(mcpLatencies, 0.95)).toBeLessThan(1_500);
			expect(restartMs).toBeLessThan(2_000);
		}
		expect(globalStateBytes).toBeGreaterThan(projectedDocumentStateBytes);
		expect(fanoutBytes).toBeGreaterThan(0);
		expect(restoredStateBytes).toBeGreaterThan(0);
		expect(listDocuments(restored.doc)).toHaveLength(profile.documents);
	});
});
