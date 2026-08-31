import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createTestHarness, type TestHarness } from '../e2e/harness';
import { getRecordYText } from '$lib/data/records';
import { plainText, yTextToRichText } from '$lib/data/richtext';
import { closeDb, getDb, getSnapshotStore } from '$lib/server/store';
import {
	catalogCollections,
	catalogDocuments,
	catalogOutbox,
	recordLocator
} from '$lib/server/db/schema';
import {
	flush,
	resetWorkspaceStoreForTests,
	resolveWorkspaceContext
} from '$lib/server/workspace-store';
import { serviceModules } from '$lib/services/manifest';
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
	// Run manually before changes that affect shard-aware transport at scale.
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

/** First, middle, and last item — a small, deterministic cross-section rather than every shard, so a `large`-scale report stays readable. */
function sample<T>(items: T[], count: number): T[] {
	if (items.length <= count) return items;
	const indices = new Set<number>([0, items.length - 1, Math.floor((items.length - 1) / 2)]);
	let cursor = 1;
	while (indices.size < count && cursor < items.length - 1) {
		indices.add(cursor);
		cursor += 1;
	}
	return [...indices].sort((a, b) => a - b).map((i) => items[i]);
}

describe('CRDT workspace capacity, real shard-aware transport (issue #123)', () => {
	let harness: TestHarness;

	beforeEach(async () => {
		harness = await createTestHarness();
	});

	afterEach(async () => {
		await harness.cleanup();
	});

	it('measures per-shard state, sync, fan-out (with cross-shard isolation), catalog size, and restart cost', async () => {
		const profileName = process.env.COMPENDIUM_BENCHMARK_PROFILE ?? 'daily';
		const profile = PROFILES[profileName];
		if (!profile) throw new Error(`Unknown benchmark profile: ${profileName}`);

		const eventLoop = monitorEventLoopDelay({ resolution: 10 });
		eventLoop.enable();
		const heapBefore = process.memoryUsage().heapUsed;
		const cpuBefore = process.cpuUsage();

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

		// --- Seed through the real service layer, not raw single-doc Yjs writes:
		// each createDocument/createCollection call resolves its own real shard
		// (resolveWorkspaceContext({shardId: id})), exactly like a production
		// create_document/create_collection MCP call — this is what makes every
		// later measurement below a genuine per-shard one. Setup work itself
		// stays outside the measured transport window, same rationale the
		// previous single-doc version of this benchmark already used.
		const documentIds: string[] = [];
		const blockIdsByDocument: string[][] = [];
		for (let d = 0; d < profile.documents; d += 1) {
			const document = serviceModules.documents.createDocument(human, {
				title: `Benchmark document ${d + 1}`
			});
			documentIds.push(document.id);
			const blocks: string[] = [];
			for (let b = 0; b < profile.blocksPerDocument; b += 1) {
				const record = serviceModules.records.createRecord(human, {
					parentId: document.id,
					blockType: 'paragraph'
				});
				serviceModules.records.writeRecord(human, record.id, {
					markdown: `Seed ${d + 1}.${b + 1}: durable workspace context.`
				});
				blocks.push(record.id);
			}
			blockIdsByDocument.push(blocks);
		}

		const collectionIds: string[] = [];
		for (let c = 0; c < profile.collections; c += 1) {
			const collection = serviceModules.collections.createCollection(human, {
				title: `Benchmark collection ${c + 1}`,
				schema
			});
			collectionIds.push(collection.id);
			for (let r = 0; r < profile.rowsPerCollection; r += 1) {
				serviceModules.records.createRecord(human, {
					parentId: collection.id,
					properties: {
						title: { type: 'text', value: `Row ${c + 1}.${r + 1}` },
						status: { type: 'select', value: r % 3 === 0 ? 'ready' : 'idea' }
					}
				});
			}
		}

		// --- Per-shard encoded state size, for a small deterministic sample ---
		const sampleDocIds = sample(documentIds, 3);
		const sampleCollectionIds = sample(collectionIds, Math.min(2, collectionIds.length));
		const perShardStateBytes: Record<string, number> = {};
		for (const id of [...sampleDocIds, ...sampleCollectionIds]) {
			const { doc } = resolveWorkspaceContext({ shardId: id });
			perShardStateBytes[id] = Y.encodeStateAsUpdate(doc).byteLength;
		}

		// --- Cold load: one client per sampled shard, connected only to that
		// shard's own room — "opening one document," not "loading the whole
		// workspace," which is the actually-representative number post-sharding.
		const shardClients = sampleDocIds.map((id) => ({
			id,
			client: harness.getYjsClient({ room: `shard-${id}`, disableBc: true })
		}));
		const coldLoadStart = performance.now();
		await Promise.all(
			shardClients.map(({ id, client }) =>
				harness.waitForCondition(
					() => client.provider.synced && client.doc.getMap('documents').has(id),
					{ timeoutMs: 20_000 }
				)
			)
		);
		const coldLoadMs = performance.now() - coldLoadStart;
		const coldLoadTotalBytes = shardClients.reduce(
			(total, { client }) => total + client.traffic.receivedBytes,
			0
		);
		const coldLoadBytesPerShard = Math.round(coldLoadTotalBytes / shardClients.length);

		// --- Fan-out, with cross-shard isolation as part of the transport cost
		// story: a same-shard peer receives the edit; a different-shard peer
		// receives nothing at all for it.
		const fanoutDocId = sampleDocIds[0];
		const fanoutBlockId = blockIdsByDocument[documentIds.indexOf(fanoutDocId)][0];
		const writerClient = harness.getYjsClient({ room: `shard-${fanoutDocId}`, disableBc: true });
		await harness.waitForCondition(
			() => getRecordYText(writerClient.doc, fanoutBlockId) !== undefined
		);
		const sameShardPeer = harness.getYjsClient({ room: `shard-${fanoutDocId}`, disableBc: true });
		await harness.waitForCondition(
			() => getRecordYText(sameShardPeer.doc, fanoutBlockId) !== undefined
		);
		const otherDocId = documentIds.find((id) => id !== fanoutDocId)!;
		const differentShardPeer = harness.getYjsClient({
			room: `shard-${otherDocId}`,
			disableBc: true
		});
		await harness.waitForCondition(() => differentShardPeer.provider.synced);

		sameShardPeer.traffic.reset();
		differentShardPeer.traffic.reset();
		const fanoutStart = performance.now();
		const writerText = getRecordYText(writerClient.doc, fanoutBlockId);
		const fanoutMarker = `Fan-out mutation ${Date.now()}.`;
		writerClient.doc.transact(() => writerText?.insert(writerText.length, ` ${fanoutMarker}`));
		await harness.waitForCondition(() => {
			const text = getRecordYText(sameShardPeer.doc, fanoutBlockId);
			return text ? plainText(yTextToRichText(text)).includes(fanoutMarker) : false;
		});
		await harness.waitForCondition(() => sameShardPeer.traffic.receivedBytes > 0, {
			timeoutMs: 2_000,
			intervalMs: 5
		});
		const fanoutLatencyMs = performance.now() - fanoutStart;
		const fanoutSameShardBytes = sameShardPeer.traffic.receivedBytes;
		// Bounded window for the different-shard peer to (not) receive anything.
		await harness.waitForCondition(() => true, { timeoutMs: 200 });
		const fanoutDifferentShardBytes = differentShardPeer.traffic.receivedBytes;

		// --- MCP write latency, spread across multiple real Document shards —
		// a realistic multi-page workload, not repeated writes to one document.
		const { token } = harness.createToken({
			clientLabel: 'Capacity benchmark MCP agent',
			allowedDocumentIds: documentIds,
			allowedCollectionIds: []
		});
		const mcp = await harness.getMcpClient(token);
		const mcpLatencies: number[] = [];
		for (let w = 0; w < profile.mcpWrites; w += 1) {
			const docIdx = w % documentIds.length;
			const blocks = blockIdsByDocument[docIdx];
			const blockId = blocks[w % blocks.length];
			const start = performance.now();
			const hold = await mcp.callTool({
				name: 'hold_records',
				arguments: { recordIds: [blockId] }
			});
			expect(parseMcpText<{ granted: string[] }>(hold).granted).toContain(blockId);
			await mcp.callTool({
				name: 'write_record',
				arguments: { recordId: blockId, markdown: `MCP benchmark revision ${w + 1}` }
			});
			mcpLatencies.push(performance.now() - start);
		}

		// --- Catalog + outbox size — the closest available proxy for a future
		// SSE catalog-refresh payload, since no SSE consumer exists yet (#121).
		const db = getDb();
		const catalogDocRows = db.select().from(catalogDocuments).all();
		const catalogCollectionRows = db.select().from(catalogCollections).all();
		const locatorRows = db.select().from(recordLocator).all();
		const catalogSizeBytes =
			JSON.stringify(catalogDocRows).length +
			JSON.stringify(catalogCollectionRows).length +
			JSON.stringify(locatorRows).length;
		const outboxRows = db.select().from(catalogOutbox).all();
		const outboxTotalPayloadBytes = outboxRows.reduce(
			(total, row) => total + JSON.stringify(row.payload).length,
			0
		);
		const outboxAvgPayloadBytes =
			outboxRows.length > 0 ? Math.round(outboxTotalPayloadBytes / outboxRows.length) : 0;

		// --- Snapshot + restart, per shard (nothing eagerly reloads every shard
		// anymore — #122's lazy-load design — so restart cost is now "reopening
		// a few documents," not "reloading everything").
		await flush();
		let totalSnapshotBytes = 0;
		for (const id of [...documentIds, ...collectionIds]) {
			const snap = getSnapshotStore('default', id).loadLatest();
			if (snap) totalSnapshotBytes += snap.byteLength;
		}

		const restartStart = performance.now();
		closeDb();
		resetWorkspaceStoreForTests();
		const restoredDocs = sampleDocIds.map((id) => resolveWorkspaceContext({ shardId: id }));
		const restartMs = performance.now() - restartStart;
		const restartMsPerShard = restartMs / sampleDocIds.length;
		eventLoop.disable();

		for (const [i, restored] of restoredDocs.entries()) {
			const meta = restored.doc.getMap('documents').get(sampleDocIds[i]) as
				Y.Map<unknown> | undefined;
			expect(meta?.get('title')).toBe(
				`Benchmark document ${documentIds.indexOf(sampleDocIds[i]) + 1}`
			);
		}

		const result = {
			profile: profileName,
			fixture: profile,
			perShardStateBytes,
			coldLoad: {
				totalBytes: coldLoadTotalBytes,
				bytesPerShard: coldLoadBytesPerShard,
				durationMs: Number(coldLoadMs.toFixed(1)),
				shardsSampled: shardClients.length
			},
			fanout: {
				sameShardBytes: fanoutSameShardBytes,
				differentShardBytes: fanoutDifferentShardBytes,
				durationMs: Number(fanoutLatencyMs.toFixed(1))
			},
			mcpWriteLatency: {
				p50Ms: Number(percentile(mcpLatencies, 0.5).toFixed(1)),
				p95Ms: Number(percentile(mcpLatencies, 0.95).toFixed(1))
			},
			catalog: {
				documentRows: catalogDocRows.length,
				collectionRows: catalogCollectionRows.length,
				locatorRows: locatorRows.length,
				estimatedSizeBytes: catalogSizeBytes
			},
			outbox: {
				rows: outboxRows.length,
				avgPayloadBytes: outboxAvgPayloadBytes,
				totalPayloadBytes: outboxTotalPayloadBytes,
				note: 'proxy only — no SSE consumer exists yet (#121)'
			},
			sse: { measured: false, reason: 'blocked on #121 (SSE feed not yet implemented)' },
			snapshot: {
				totalBytesAllShards: totalSnapshotBytes,
				shardCount: documentIds.length + collectionIds.length
			},
			restart: {
				durationMs: Number(restartMs.toFixed(1)),
				shardsSampled: sampleDocIds.length,
				msPerShard: Number(restartMsPerShard.toFixed(2))
			},
			process: {
				heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
				cpuUserMicros: process.cpuUsage(cpuBefore).user,
				eventLoopP99Ms: Number((eventLoop.percentile(99) / 1e6).toFixed(2))
			}
		};
		console.log(`CRDT_CAPACITY_RESULT ${JSON.stringify(result)}`);

		// Cross-shard isolation is a hard guarantee at every profile, not just a
		// daily-profile guardrail: a different shard's client must receive
		// exactly zero bytes for an edit it was never subscribed to.
		expect(fanoutDifferentShardBytes).toBe(0);
		expect(fanoutSameShardBytes).toBeGreaterThan(0);
		expect(catalogDocRows.length).toBe(profile.documents);
		expect(catalogCollectionRows.length).toBe(profile.collections);

		// Conservative daily-workspace guardrails, set from a real measured run
		// (see docs/benchmarks/ for the dated note) — not guessed blind. Larger
		// profiles are reporting runs, not CI gates, until #24 defines
		// user-facing latency SLOs.
		if (profileName === 'daily') {
			expect(coldLoadBytesPerShard).toBeLessThan(30_000);
			expect(coldLoadMs).toBeLessThan(1_000);
			expect(percentile(mcpLatencies, 0.95)).toBeLessThan(1_500);
			expect(restartMsPerShard).toBeLessThan(100);
		}
	});
});
