import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './harness';
import { createRecord, getRecordYText, updateRecordContent } from '$lib/data/record-ops';
import {
	createSpace,
	recordCatalogDocumentCreated,
	reserveDocumentLocator
} from '$lib/server/catalog';
import { grantDocumentAccess } from '$lib/mcp/tokens';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { plainText, yTextToRichText } from '$lib/data/richtext';
import { serviceModules } from '$lib/services/manifest';
import { TEST_ORIGIN, transactWithOrigin } from '$lib/mutation-origin';
import { createDocument, human, parseMcpText } from './mcp-parity-helpers';

describe('Document/Shard/Space Routing', () => {
	let harness: TestHarness;

	beforeEach(async () => {
		harness = await createTestHarness();
	});

	afterEach(async () => {
		await harness?.cleanup();
	});

	it('3. MCP create_document (nested) -> second independent MCP call on new document succeeds', async () => {
		const yjs = harness.getYjsClient();
		const rootDoc = createDocument(yjs.doc, { title: 'Parent Workspace' });

		const { token } = harness.createToken({
			clientLabel: 'Subpage Creator Bot',
			allowedDocumentIds: [rootDoc.id],
			allowedCollectionIds: []
		});

		const mcp = await harness.getMcpClient(token);

		// 1st call: create nested document
		const createRes = await mcp.callTool({
			name: 'create_document',
			arguments: {
				title: 'Agent Subpage',
				parentDocumentId: rootDoc.id
			}
		});
		const newDoc = parseMcpText<{ id: string; parentDocumentId?: string }>(createRes);
		expect(newDoc.id).toBeDefined();
		expect(newDoc.parentDocumentId).toBe(rootDoc.id);

		// Open a separate 2nd MCP client with the same token to guarantee cold request state
		const mcp2 = await harness.getMcpClient(token);

		// 2nd call: read document and write to it
		const getRes = await mcp2.callTool({
			name: 'get_document',
			arguments: { documentId: newDoc.id }
		});
		const docData = parseMcpText<{ id: string; title: string }>(getRes);
		expect(docData.id).toBe(newDoc.id);
		expect(docData.title).toBe('Agent Subpage');

		// 3rd call: create record in new doc
		const createBlockRes = await mcp2.callTool({
			name: 'create_record',
			arguments: {
				parentId: newDoc.id,
				blockType: 'heading_1'
			}
		});
		expect(parseMcpText<{ recordId: string }>(createBlockRes).recordId).toBeDefined();
	});
	it("3b. A Document created via the service layer lives in its own real shard, and a client connected to it never sees another shard's updates (#120)", async () => {
		const { token } = harness.createToken({
			clientLabel: 'Shard Isolation Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});
		const mcp = await harness.getMcpClient(token);

		// create_document goes through the service layer, so this Document
		// gets a real, distinct shard — its own id (see services/documents.ts).
		const createRes = await mcp.callTool({
			name: 'create_document',
			arguments: { title: 'Sharded Doc' }
		});
		const newDoc = parseMcpText<{ id: string }>(createRes);

		const createBlockRes = await mcp.callTool({
			name: 'create_record',
			arguments: { parentId: newDoc.id, blockType: 'paragraph' }
		});
		const block = parseMcpText<{ recordId: string }>(createBlockRes);

		const holdRes = await mcp.callTool({
			name: 'hold_records',
			arguments: { recordIds: [block.recordId] }
		});
		expect(parseMcpText<{ granted: string[] }>(holdRes).granted).toContain(block.recordId);

		await mcp.callTool({
			name: 'write_record',
			arguments: { recordId: block.recordId, markdown: 'Real shard content' }
		});

		// A Yjs client connected to this Document's own real shard room
		// observes the content.
		const shardClient = harness.getYjsClient({ room: `shard-${newDoc.id}` });
		await harness.waitForCondition(() => {
			const ytext = getRecordYText(shardClient.doc, block.recordId);
			if (!ytext) return false;
			return plainText(yTextToRichText(ytext)).includes('Real shard content');
		});

		// A Yjs client connected to the shared 'workspace' room (unsharded
		// Documents' room, and every pre-#120 client's default) never
		// receives this shard's content — proving shard isolation, not just
		// that connecting to the right room happens to work.
		const workspaceClient = harness.getYjsClient();
		await harness.waitForCondition(() => true, { timeoutMs: 200 }); // let sync settle
		expect(getRecordYText(workspaceClient.doc, block.recordId)).toBeUndefined();
		expect(workspaceClient.doc.getMap('documents').has(newDoc.id)).toBe(false);
	});
	it('3b-2. A record created via direct UI mutation in a per-Document shard is still reachable by MCP write_record/hold_records/delete_record, not silently misrouted to the default shard (issue #253)', async () => {
		const { token } = harness.createToken({
			clientLabel: 'Locator Gap Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});
		const mcp = await harness.getMcpClient(token);

		// create_document goes through the service layer, so this Document gets
		// a real, distinct shard — its own id (see services/documents.ts, #120).
		const createRes = await mcp.callTool({
			name: 'create_document',
			arguments: { title: 'Human-Typed Doc' }
		});
		const newDoc = parseMcpText<{ id: string }>(createRes);

		// A real Yjs client connects to the Document's own shard room and types
		// a block directly via the raw data-layer createRecord — the same path
		// BlockEditor.svelte uses (no MCP/service call), so no locator would be
		// reserved for this block without record-locator-observer.ts.
		const shardClient = harness.getYjsClient({ room: `shard-${newDoc.id}` });
		await harness.waitForCondition(() => shardClient.doc.getMap('documents').has(newDoc.id));
		const block = createRecord(
			shardClient.doc,
			{ parentId: newDoc.id, blockType: 'paragraph' },
			human
		);

		// Before the fix, requireAccessibleRecord's shard resolution falls back
		// to the *default* shard for this bare recordId (no locator reserved),
		// where the record doesn't exist, so every one of these calls 404s
		// forever rather than eventually succeeding once sync catches up.
		await harness.waitForCondition(
			async () => {
				const holdRes = await mcp.callTool({
					name: 'hold_records',
					arguments: { recordIds: [block.id] }
				});
				return parseMcpText<{ granted: string[] }>(holdRes).granted.includes(block.id);
			},
			{ timeoutMs: 1500 }
		);

		const writeRes = await mcp.callTool({
			name: 'write_record',
			arguments: { recordId: block.id, markdown: 'Written by an agent' }
		});
		expect((writeRes as { isError?: boolean }).isError).not.toBe(true);

		await harness.waitForCondition(() => {
			const ytext = getRecordYText(shardClient.doc, block.id);
			if (!ytext) return false;
			return plainText(yTextToRichText(ytext)).includes('Written by an agent');
		});

		const deleteRes = await mcp.callTool({
			name: 'delete_record',
			arguments: { recordId: block.id }
		});
		expect((deleteRes as { isError?: boolean }).isError).not.toBe(true);
	});
	it("3c. MCP search_workspace's space_id never crosses a Space boundary (#114/#133)", async () => {
		const { token, record } = harness.createToken({
			clientLabel: 'Space Isolation Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});
		const mcp = await harness.getMcpClient(token);

		// create_document (real MCP call, service layer) lands in the
		// workspace's default Space and auto-grants this token access to it.
		const createRes = await mcp.callTool({
			name: 'create_document',
			arguments: { title: 'Space A Doc' }
		});
		const docA = parseMcpText<{ id: string }>(createRes);
		const blockA = await mcp.callTool({
			name: 'create_record',
			arguments: { parentId: docA.id, blockType: 'paragraph' }
		});
		const recordA = parseMcpText<{ recordId: string }>(blockA);
		await mcp.callTool({
			name: 'hold_records',
			arguments: { recordIds: [recordA.recordId] }
		});
		await mcp.callTool({
			name: 'write_record',
			arguments: { recordId: recordA.recordId, markdown: 'unicornsparkle' }
		});

		// A second Space, with a Document created directly (no MCP tool for
		// this exists yet — see #133's own non-goal), holding the same
		// searchable text — proving a real cross-Space leak would be caught,
		// not just that an empty other Space returns nothing.
		const { workspaceId } = resolveWorkspaceContext();
		const spaceB = createSpace(workspaceId, 'Space B');
		const docBShard = resolveWorkspaceContext({ workspaceId, shardId: 'tier-a-space-b-doc' });
		const docB = createDocument(docBShard.doc, {
			id: 'tier-a-space-b-doc',
			title: 'Space B Doc'
		});
		reserveDocumentLocator(workspaceId, spaceB.id, docB.id, docBShard.shardId);
		recordCatalogDocumentCreated({
			workspaceId,
			spaceId: spaceB.id,
			id: docB.id,
			title: docB.title,
			order: docB.order,
			shardId: docBShard.shardId
		});
		const recordB = transactWithOrigin(docBShard.doc, TEST_ORIGIN, () =>
			createRecord(docBShard.doc, { parentId: docB.id, blockType: 'paragraph' }, human)
		);
		transactWithOrigin(docBShard.doc, TEST_ORIGIN, () =>
			updateRecordContent(
				docBShard.doc,
				recordB.id,
				{ runs: [{ text: 'unicornsparkle', marks: {} }] },
				human
			)
		);

		// Grant this same token access to docB too — otherwise the pre-existing
		// per-ID token filter alone would exclude recordB regardless of whether
		// space_id filtering does anything at all, and the isolation assertion
		// below would pass for the wrong reason.
		grantDocumentAccess(record.tokenHash, docB.id);

		// Baseline: with no Space filter, the token can see both records —
		// proves access and content are both genuinely in place before testing
		// that space_id actually does the excluding.
		const unscopedRes = await mcp.callTool({
			name: 'search_workspace',
			arguments: { query: 'unicornsparkle' }
		});
		const unscopedResults = parseMcpText<{ recordId: string }[]>(unscopedRes);
		expect(unscopedResults.map((r) => r.recordId)).toContain(recordA.recordId);
		expect(unscopedResults.map((r) => r.recordId)).toContain(recordB.id);

		// The real MCP client, scoped to Space A, never sees Space B's match —
		// exercised over the actual HTTP transport, not an in-process call.
		const { defaultSpaceId: spaceAId } = resolveWorkspaceContext();
		const scopedRes = await mcp.callTool({
			name: 'search_workspace',
			arguments: { query: 'unicornsparkle', space_id: spaceAId }
		});
		const scopedResults = parseMcpText<{ recordId: string }[]>(scopedRes);
		expect(scopedResults.map((r) => r.recordId)).toContain(recordA.recordId);
		expect(scopedResults.map((r) => r.recordId)).not.toContain(recordB.id);
	});
	it("3c-2. MCP query_collection's filter argument round-trips through the real Zod schema and applies the same ViewFilter semantics the UI uses (issue #70)", async () => {
		const col = serviceModules.collections.createCollection(human, {
			title: 'Filter Wiring Collection',
			schema: [{ key: 'status', label: 'Status', type: 'select' }]
		});
		const { token } = harness.createToken({
			clientLabel: 'Filter Wiring Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: [col.id]
		});
		const mcp = await harness.getMcpClient(token);

		await mcp.callTool({
			name: 'create_record',
			arguments: { parentId: col.id, properties: { status: { type: 'select', value: 'todo' } } }
		});
		const doneRow = await mcp.callTool({
			name: 'create_record',
			arguments: { parentId: col.id, properties: { status: { type: 'select', value: 'done' } } }
		});
		const doneRecord = parseMcpText<{ recordId: string }>(doneRow);

		const filteredRes = await mcp.callTool({
			name: 'query_collection',
			arguments: {
				collectionId: col.id,
				filter: [{ propertyKey: 'status', op: 'is', value: 'done' }]
			}
		});
		const filtered = parseMcpText<{ rows: { id: string }[] }>(filteredRes);
		expect(filtered.rows.map((r) => r.id)).toEqual([doneRecord.recordId]);

		const unfilteredRes = await mcp.callTool({
			name: 'query_collection',
			arguments: { collectionId: col.id }
		});
		const unfiltered = parseMcpText<{ rows: { id: string }[] }>(unfilteredRes);
		expect(unfiltered.rows).toHaveLength(2);
	});
});
