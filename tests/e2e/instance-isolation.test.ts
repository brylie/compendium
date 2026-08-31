import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './harness';
import { getRecordYText } from '$lib/data/records';

// Proves #111/#138's core guarantee through the real MCP + Yjs protocol
// boundary: two differently-configured instances (COMPENDIUM_INSTANCE_ID
// driving getInstanceWorkspaceId()'s resolution, see src/lib/server/
// instance.ts) never observe each other's content, even within one process
// and one shared SQLite file — the workspace-keyed registry
// (workspace-store.ts) genuinely isolates once workspaceId actually varies
// by configuration, which is exactly what these two "instances" simulate.
// This is the mechanism-level proof; real separate-process isolation
// (separate DATABASE_URLs, separate ports) already holds today and isn't
// what this test re-proves.

function parseMcpText<T>(result: unknown): T {
	const response = result as { content?: Array<{ text?: string }>; isError?: boolean };
	if (response.isError) throw new Error(response.content?.[0]?.text ?? 'MCP tool failed');
	return JSON.parse(response.content?.[0]?.text ?? '') as T;
}

describe('Instance isolation: two configured instances never cross-observe (#111/#138)', () => {
	let harness: TestHarness;

	beforeEach(async () => {
		harness = await createTestHarness();
	});

	afterEach(async () => {
		delete process.env.COMPENDIUM_INSTANCE_ID;
		await harness.cleanup();
	});

	it("list_documents scoped to one instance never returns the other instance's Documents", async () => {
		process.env.COMPENDIUM_INSTANCE_ID = 'instance-a';
		const { token: tokenA } = harness.createToken({
			clientLabel: 'Instance A Agent',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});
		const mcpA = await harness.getMcpClient(tokenA);
		const createResA = await mcpA.callTool({
			name: 'create_document',
			arguments: { title: 'Instance A Doc' }
		});
		const docA = parseMcpText<{ id: string }>(createResA);

		process.env.COMPENDIUM_INSTANCE_ID = 'instance-b';
		const { token: tokenB } = harness.createToken({
			clientLabel: 'Instance B Agent',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});
		const mcpB = await harness.getMcpClient(tokenB);
		const createResB = await mcpB.callTool({
			name: 'create_document',
			arguments: { title: 'Instance B Doc' }
		});
		const docB = parseMcpText<{ id: string }>(createResB);

		// Back on instance-a: mcpA's own list_documents call still resolves
		// against instance-a's workspace (the env var only affects which
		// workspace new resolutions default to; mcpA's token/behavior is
		// otherwise unaffected by the intervening instance-b calls).
		process.env.COMPENDIUM_INSTANCE_ID = 'instance-a';
		const listResA = await mcpA.callTool({ name: 'list_documents', arguments: {} });
		const listA = parseMcpText<Array<{ id: string }>>(listResA);
		expect(listA.map((d) => d.id)).toContain(docA.id);
		expect(listA.map((d) => d.id)).not.toContain(docB.id);

		process.env.COMPENDIUM_INSTANCE_ID = 'instance-b';
		const listResB = await mcpB.callTool({ name: 'list_documents', arguments: {} });
		const listB = parseMcpText<Array<{ id: string }>>(listResB);
		expect(listB.map((d) => d.id)).toContain(docB.id);
		expect(listB.map((d) => d.id)).not.toContain(docA.id);
	});

	it("a Yjs client connected to one instance's shard never observes the other instance's content", async () => {
		process.env.COMPENDIUM_INSTANCE_ID = 'instance-a';
		const { token: tokenA } = harness.createToken({
			clientLabel: 'Instance A Agent',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});
		const mcpA = await harness.getMcpClient(tokenA);
		const createResA = await mcpA.callTool({
			name: 'create_document',
			arguments: { title: 'Instance A Doc' }
		});
		const docA = parseMcpText<{ id: string }>(createResA);
		const blockResA = await mcpA.callTool({
			name: 'create_record',
			arguments: { parentId: docA.id, blockType: 'paragraph' }
		});
		const blockA = parseMcpText<{ recordId: string }>(blockResA);
		await mcpA.callTool({ name: 'hold_records', arguments: { recordIds: [blockA.recordId] } });
		await mcpA.callTool({
			name: 'write_record',
			arguments: { recordId: blockA.recordId, markdown: 'instance-a-secret-content' }
		});

		// A Yjs client connects to instance-a's own shard room and observes it.
		const shardClientA = harness.getYjsClient({ room: `shard-${docA.id}` });
		await harness.waitForCondition(
			() => getRecordYText(shardClientA.doc, blockA.recordId) !== undefined
		);

		process.env.COMPENDIUM_INSTANCE_ID = 'instance-b';
		const { token: tokenB } = harness.createToken({
			clientLabel: 'Instance B Agent',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});
		const mcpB = await harness.getMcpClient(tokenB);
		// instance-b's own list_documents never sees instance-a's Document at
		// all, so it can never even learn docA.id to try connecting to its
		// shard — the isolation is at the discovery layer, not just content.
		const listResB = await mcpB.callTool({ name: 'list_documents', arguments: {} });
		const listB = parseMcpText<Array<{ id: string }>>(listResB);
		expect(listB.map((d) => d.id)).not.toContain(docA.id);

		// Even a client that somehow already knows docA.id (guessed, leaked,
		// whatever) can't connect to its shard room from instance-b: the
		// server-side isKnownShard check (#111/#138) is scoped by the
		// *resolving* instance's own workspaceId, so docA's shard is unknown
		// from instance-b's catalog even though the id itself is valid on
		// instance-a. Still on COMPENDIUM_INSTANCE_ID = 'instance-b' here.
		const shardClientB = harness.getYjsClient({ room: `shard-${docA.id}` });
		const closeEvent = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error('connection-close not observed')), 2000);
			shardClientB.provider.on('connection-close', (event: CloseEvent | null) => {
				clearTimeout(timeout);
				resolve({ code: event?.code ?? -1, reason: event?.reason ?? '' });
			});
		});
		expect(closeEvent.code).toBe(4404);
		shardClientB.disconnect();
	});
});
