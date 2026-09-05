import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './harness';
import {
	createCollection,
	createDocument as createDocumentRaw,
	createRecord,
	getRecord,
	getRecordYText,
	touchRecordEditor,
	updateRecordContent
} from '$lib/data/records';
import { queryAuditLog } from '$lib/server/audit';
import {
	createSpace,
	recordCatalogDocumentCreated,
	reserveDocumentLocator
} from '$lib/server/catalog';
import { grantDocumentAccess } from '$lib/mcp/tokens';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { plainText, yTextToRichText } from '$lib/data/richtext';
import { serviceModules, serviceSurfaces } from '$lib/services/manifest';
import { flushPendingAuditEvents } from '$lib/server/audit-observer';
import { deleteRecord as crdtDeleteRecord } from '$lib/data/records';
import type { ActorId } from '$lib/data/types';
import { TEST_ORIGIN, transactWithOrigin } from '$lib/mutation-origin';

const human: ActorId = { kind: 'human', userId: 'brylie' };

// The server-side workspace contexts used by the cross-space tests have
// projection observers attached. Keep direct fixture mutations explicit so
// they exercise the same origin contract as every other test write.
function createDocument(
	doc: Parameters<typeof createDocumentRaw>[0],
	input: Parameters<typeof createDocumentRaw>[1]
) {
	return transactWithOrigin(doc, TEST_ORIGIN, () => createDocumentRaw(doc, input));
}

// A generic assertion-sugar helper: T is used only once in the
// signature (this rule's own "replace with the constraint" fix would
// collapse every call site's return type to `unknown`), but that single
// use is exactly the point — dozens of call sites below rely on
// parseMcpText<SomeShape>(result) inferring their own precise return
// type instead of each repeating its own `as SomeShape` cast.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function parseMcpText<T = unknown>(result: unknown): T {
	const r = result as { content?: { text?: string }[]; isError?: boolean };
	if (r.isError) {
		const text = r.content?.[0]?.text ?? 'Unknown error';
		throw new Error(`MCP Error: ${text}`);
	}
	const text = r.content?.[0]?.text ?? '';
	return text ? (JSON.parse(text) as T) : (null as unknown as T);
}

function getResultText(result: unknown): string {
	const r = result as { content?: { text?: string }[] };
	return r.content?.[0]?.text ?? '';
}

describe('Tier A: Protocol-Level MCP & Yjs E2E Parity', () => {
	let harness: TestHarness;

	beforeEach(async () => {
		harness = await createTestHarness();
	});

	afterEach(async () => {
		await harness?.cleanup();
	});

	it('1. MCP write_record -> Yjs websocket client observes new content within latency bound', async () => {
		const yjs = harness.getYjsClient();

		// Create a document and block via human
		const docMeta = createDocument(yjs.doc, { title: 'Collaboration Spec' });
		const block = createRecord(yjs.doc, { parentId: docMeta.id, blockType: 'paragraph' }, human);

		const { token } = harness.createToken({
			clientLabel: 'Agent Claude',
			allowedDocumentIds: [docMeta.id],
			allowedCollectionIds: []
		});

		const mcp = await harness.getMcpClient(token);

		// Wait for initial sync
		await harness.waitForCondition(() => {
			const ytext = getRecordYText(yjs.doc, block.id);
			return ytext !== undefined;
		});

		// MCP agent acquires hold
		const holdRes = await mcp.callTool({
			name: 'hold_records',
			arguments: { recordIds: [block.id] }
		});
		expect(parseMcpText<{ granted: string[] }>(holdRes).granted).toContain(block.id);

		// MCP agent writes new content over HTTP transport
		await mcp.callTool({
			name: 'write_record',
			arguments: {
				recordId: block.id,
				markdown: 'Hello from MCP agent over live transport!'
			}
		});

		// Assert that the real Yjs websocket client observes the edit within latency bound
		await harness.waitForCondition(
			() => {
				const ytext = getRecordYText(yjs.doc, block.id);
				if (!ytext) return false;
				const text = plainText(yTextToRichText(ytext));
				return text.includes('Hello from MCP agent over live transport!');
			},
			{ timeoutMs: 1500 }
		);
	});

	it('2. Yjs client write -> independent MCP get_document call observes it', async () => {
		const yjs = harness.getYjsClient();

		const docMeta = createDocument(yjs.doc, { title: 'Live Notes' });
		const block = createRecord(yjs.doc, { parentId: docMeta.id, blockType: 'paragraph' }, human);

		const { token } = harness.createToken({
			clientLabel: 'Reader Agent',
			allowedDocumentIds: [docMeta.id],
			allowedCollectionIds: []
		});

		const mcp = await harness.getMcpClient(token);

		// Wait for sync
		await harness.waitForCondition(() => getRecordYText(yjs.doc, block.id) !== undefined);

		// Yjs client modifies block content
		const ytext = getRecordYText(yjs.doc, block.id)!;
		yjs.doc.transact(() => {
			ytext.insert(0, 'Content typed by human in browser');
		});

		// MCP makes independent get_document call
		let observedMarkdown = '';
		await harness.waitForCondition(
			async () => {
				const res = await mcp.callTool({
					name: 'get_document',
					arguments: { documentId: docMeta.id }
				});
				const data = parseMcpText<{ records: { id: string; markdown: string }[] }>(res);
				const rec = data.records.find((r) => r.id === block.id);
				if (rec?.markdown.includes('Content typed by human in browser')) {
					observedMarkdown = rec.markdown;
					return true;
				}
				return false;
			},
			{ timeoutMs: 1500 }
		);

		expect(observedMarkdown).toContain('Content typed by human in browser');
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

	it('3d. A token granted only a Space (#6) reads any Document created directly in it, over the real MCP transport, and is denied a different Space', async () => {
		const { workspaceId, defaultSpaceId: spaceAId } = resolveWorkspaceContext();
		const spaceB = createSpace(workspaceId, 'Space B');

		// A Document created directly in Space A — never individually granted to
		// any token, and never touched by create_document (which would have
		// auto-granted it) — the only way this token can reach it is the
		// Space-level allowlist itself.
		const docAShard = resolveWorkspaceContext({ workspaceId, shardId: 'tier-a-3d-space-a-doc' });
		const docA = createDocument(docAShard.doc, {
			id: 'tier-a-3d-space-a-doc',
			title: 'Space A Doc (Space-granted only)'
		});
		reserveDocumentLocator(workspaceId, spaceAId, docA.id, docAShard.shardId);
		recordCatalogDocumentCreated({
			workspaceId,
			spaceId: spaceAId,
			id: docA.id,
			title: docA.title,
			order: docA.order,
			shardId: docAShard.shardId
		});

		const docBShard = resolveWorkspaceContext({ workspaceId, shardId: 'tier-a-3d-space-b-doc' });
		const docB = createDocument(docBShard.doc, {
			id: 'tier-a-3d-space-b-doc',
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

		const { token } = harness.createToken({
			clientLabel: 'Space-Scoped Agent',
			allowedDocumentIds: [],
			allowedCollectionIds: [],
			allowedSpaceIds: [spaceAId]
		});
		const mcp = await harness.getMcpClient(token);

		const getA = await mcp.callTool({ name: 'get_document', arguments: { documentId: docA.id } });
		expect(parseMcpText<{ id: string }>(getA).id).toBe(docA.id);

		const getB = await mcp.callTool({ name: 'get_document', arguments: { documentId: docB.id } });
		expect((getB as { isError?: boolean }).isError).toBe(true);

		// list_documents (unscoped, no space_id filter) reflects the same grant.
		const listRes = await mcp.callTool({ name: 'list_documents', arguments: {} });
		const list = parseMcpText<{ id: string }[]>(listRes);
		expect(list.map((d) => d.id)).toContain(docA.id);
		expect(list.map((d) => d.id)).not.toContain(docB.id);
	});

	it('4. MCP hold_records on block where human cursor is -> denied for that block, granted for others', async () => {
		const yjs = harness.getYjsClient();
		const docMeta = createDocument(yjs.doc, { title: 'Shared Doc' });
		const block1 = createRecord(yjs.doc, { parentId: docMeta.id, blockType: 'paragraph' }, human);
		const block2 = createRecord(yjs.doc, { parentId: docMeta.id, blockType: 'paragraph' }, human);

		const { token } = harness.createToken({
			clientLabel: 'Cautious Agent',
			allowedDocumentIds: [docMeta.id],
			allowedCollectionIds: []
		});

		const mcp = await harness.getMcpClient(token);

		// Human places cursor in block1 via Awareness
		yjs.awareness.setLocalState({
			actor: human,
			heldRecordIds: [block1.id]
		});

		// Wait for awareness state to propagate
		await harness.waitForCondition(() => {
			const states = Array.from(resolveWorkspaceContext().awareness.getStates().values()) as {
				heldRecordIds?: string[];
			}[];
			return states.some((s) => s.heldRecordIds?.includes(block1.id));
		});

		// Agent requests holds on both block1 and block2
		const holdRes = await mcp.callTool({
			name: 'hold_records',
			arguments: { recordIds: [block1.id, block2.id] }
		});
		const data = parseMcpText<{ granted: string[]; denied: string[] }>(holdRes);

		expect(data.denied).toContain(block1.id);
		expect(data.granted).toContain(block2.id);
	});

	it('5. MCP holds block, Yjs client starts editing -> hold releases, human edit preserved', async () => {
		const yjs = harness.getYjsClient();
		const docMeta = createDocument(yjs.doc, { title: 'Conflict Doc' });
		const block = createRecord(yjs.doc, { parentId: docMeta.id, blockType: 'paragraph' }, human);

		const { token } = harness.createToken({
			clientLabel: 'Interrupted Agent',
			allowedDocumentIds: [docMeta.id],
			allowedCollectionIds: []
		});

		const mcp = await harness.getMcpClient(token);

		// Agent requests hold
		const holdRes = await mcp.callTool({
			name: 'hold_records',
			arguments: { recordIds: [block.id] }
		});
		expect(parseMcpText<{ granted: string[] }>(holdRes).granted).toContain(block.id);

		// Human types in block via CRDT
		await harness.waitForCondition(() => getRecordYText(yjs.doc, block.id) !== undefined);
		const ytext = getRecordYText(yjs.doc, block.id)!;
		yjs.doc.transact(() => {
			ytext.insert(0, 'Human typed first');
		});

		// Human claims cursor presence
		yjs.awareness.setLocalState({
			actor: human,
			heldRecordIds: [block.id]
		});

		await harness.waitForCondition(() => {
			const states = Array.from(resolveWorkspaceContext().awareness.getStates().values()) as {
				heldRecordIds?: string[];
			}[];
			return states.some((s) => s.heldRecordIds?.includes(block.id));
		});

		// Agent now tries to write -> should fail because hold was released
		const writeRes = await mcp.callTool({
			name: 'write_record',
			arguments: {
				recordId: block.id,
				markdown: 'Agent overwrite attempt'
			}
		});
		expect(writeRes.isError).toBe(true);

		// Verify human text remains intact
		expect(plainText(yTextToRichText(ytext))).toContain('Human typed first');
	});

	it('6. Token scoped to one document -> MCP calls against any other document return permission denied', async () => {
		const yjs = harness.getYjsClient();
		const docAllowed = createDocument(yjs.doc, { title: 'Allowed Document' });
		const docForbidden = createDocument(yjs.doc, { title: 'Forbidden Document' });

		const { token } = harness.createToken({
			clientLabel: 'Restricted Agent',
			allowedDocumentIds: [docAllowed.id],
			allowedCollectionIds: []
		});

		const mcp = await harness.getMcpClient(token);

		// Reading allowed document succeeds
		const allowedRes = await mcp.callTool({
			name: 'get_document',
			arguments: { documentId: docAllowed.id }
		});
		expect(allowedRes.isError).toBeFalsy();

		// Reading forbidden document fails
		const forbiddenRes = await mcp.callTool({
			name: 'get_document',
			arguments: { documentId: docForbidden.id }
		});
		expect(forbiddenRes.isError).toBe(true);
		expect(getResultText(forbiddenRes)).toContain('Permission denied');

		// Creating block in forbidden document fails
		const createBlockRes = await mcp.callTool({
			name: 'create_record',
			arguments: { parentId: docForbidden.id, blockType: 'paragraph' }
		});
		expect(createBlockRes.isError).toBe(true);
		expect(getResultText(createBlockRes)).toContain('Permission denied');
	});

	it('7. Every MCP write/delete call produces a corresponding correctly-attributed audit entry', async () => {
		const yjs = harness.getYjsClient();
		const docMeta = createDocument(yjs.doc, { title: 'Audited Doc' });

		const { token } = harness.createToken({
			clientLabel: 'Audited Agent',
			allowedDocumentIds: [docMeta.id],
			allowedCollectionIds: []
		});

		const mcp = await harness.getMcpClient(token);

		// 1. Create record
		const createRes = await mcp.callTool({
			name: 'create_record',
			arguments: { parentId: docMeta.id, blockType: 'to_do' }
		});
		const blockId = parseMcpText<{ recordId: string }>(createRes).recordId;

		// 2. Write record
		await mcp.callTool({ name: 'hold_records', arguments: { recordIds: [blockId] } });
		await mcp.callTool({
			name: 'write_record',
			arguments: { recordId: blockId, markdown: 'Buy milk' }
		});

		// 3. Delete record
		await mcp.callTool({
			name: 'delete_record',
			arguments: { recordId: blockId }
		});

		// Check audit entries in SQLite
		const entries = queryAuditLog();
		const actions = entries.map((e) => e.action);

		expect(actions).toContain('create_record');
		expect(actions).toContain('hold_records');
		expect(actions).toContain('write_record');
		expect(actions).toContain('delete_record');

		const agentEntries = entries.filter(
			(e) => e.actor.kind === 'human-via-client' && e.actor.client === 'Audited Agent'
		);
		expect(agentEntries.length).toBeGreaterThanOrEqual(4);
	});

	it('8. MCP move_document -> reflects new hierarchy and enforces new permission boundary', async () => {
		const yjs = harness.getYjsClient();
		const folderA = createDocument(yjs.doc, { title: 'Folder A' });
		const folderB = createDocument(yjs.doc, { title: 'Folder B' });
		const childDoc = createDocument(yjs.doc, { title: 'Child Doc', parentDocumentId: folderA.id });

		// Token allowed on all 3 docs
		const { token: tokenMover } = harness.createToken({
			clientLabel: 'Mover Bot',
			allowedDocumentIds: [folderA.id, folderB.id, childDoc.id],
			allowedCollectionIds: []
		});

		const mcpMover = await harness.getMcpClient(tokenMover);

		// Move childDoc under folderB
		const moveRes = await mcpMover.callTool({
			name: 'move_document',
			arguments: {
				documentId: childDoc.id,
				parentDocumentId: folderB.id
			}
		});
		expect(parseMcpText<{ success: boolean }>(moveRes).success).toBe(true);

		// Verify get_document reflects new parent
		const getRes = await mcpMover.callTool({
			name: 'get_document',
			arguments: { documentId: childDoc.id }
		});
		expect(parseMcpText<{ parentDocumentId?: string }>(getRes).parentDocumentId).toBe(folderB.id);

		// Token scoped only to Folder A cannot move a document into Folder B
		const { token: tokenRestricted } = harness.createToken({
			clientLabel: 'Restricted Bot',
			allowedDocumentIds: [folderA.id, childDoc.id],
			allowedCollectionIds: []
		});
		const mcpRestricted = await harness.getMcpClient(tokenRestricted);

		const illegalMoveRes = await mcpRestricted.callTool({
			name: 'move_document',
			arguments: {
				documentId: childDoc.id,
				parentDocumentId: folderB.id
			}
		});
		expect(illegalMoveRes.isError).toBe(true);
		expect(getResultText(illegalMoveRes)).toContain('Permission denied');
	});

	it('9. MCP holds a block, calls release_records without writing -> hold releases cleanly', async () => {
		const yjs = harness.getYjsClient();
		const docMeta = createDocument(yjs.doc, { title: 'Hold Release Doc' });
		const block = createRecord(yjs.doc, { parentId: docMeta.id, blockType: 'paragraph' }, human);

		const { token } = harness.createToken({
			clientLabel: 'Releasing Agent',
			allowedDocumentIds: [docMeta.id],
			allowedCollectionIds: []
		});

		const mcp = await harness.getMcpClient(token);

		// Hold
		const holdRes = await mcp.callTool({
			name: 'hold_records',
			arguments: { recordIds: [block.id] }
		});
		expect(parseMcpText<{ granted: string[] }>(holdRes).granted).toContain(block.id);

		// Release
		const releaseRes = await mcp.callTool({
			name: 'release_records',
			arguments: { recordIds: [block.id] }
		});
		expect(parseMcpText<{ success: boolean }>(releaseRes).success).toBe(true);

		// Writing now fails because hold was released
		const writeRes = await mcp.callTool({
			name: 'write_record',
			arguments: {
				recordId: block.id,
				markdown: 'Should fail'
			}
		});
		expect(writeRes.isError).toBe(true);
	});

	it('10. Service layer manifest wiring check: validates all MCP tools and UI surface side effects', async () => {
		const methods = Object.keys(serviceSurfaces) as (keyof typeof serviceSurfaces)[];
		expect(methods.length).toBeGreaterThanOrEqual(15);

		// 1. Verify all mcp: true entries are wired and discoverable over MCP transport
		const { token } = harness.createToken({
			clientLabel: 'Manifest Inspector',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});
		const mcp = await harness.getMcpClient(token);
		const toolList = await mcp.listTools();
		const toolNames = toolList.tools.map((t) => t.name);

		for (const method of methods) {
			const surface = serviceSurfaces[method];
			if (surface.mcp) {
				expect(surface.mcpToolName).toBeDefined();
				expect(toolNames).toContain(surface.mcpToolName);
			}
		}

		// 2. Parametrize and execute every ui: true entry, asserting the required service side-effect occurred
		const testDoc = serviceModules.documents.createDocument(human, {
			title: 'Manifest Wiring Doc',
			createInitialBlock: true
		});
		const testBlock = serviceModules.records.createRecord(human, {
			parentId: testDoc.id,
			blockType: 'paragraph'
		});
		const testCol = serviceModules.collections.createCollection(human, {
			title: 'Manifest Wiring Col',
			schema: [{ key: 'status', label: 'Status', type: 'select' }]
		});

		for (const method of methods) {
			const surface = serviceSurfaces[method];
			if (!surface.ui) continue;

			switch (method) {
				case 'documents.createDocument': {
					const d = serviceModules.documents.createDocument(human, { title: 'Wiring Sub' });
					expect(d.id).toBeDefined();
					const log = queryAuditLog().filter((e) => e.targetRecordId === d.id);
					expect(log.some((e) => e.action === 'create_document')).toBe(true);
					break;
				}
				case 'documents.updateDocumentTitle': {
					serviceModules.documents.updateDocumentTitle(human, testDoc.id, 'Renamed Doc');
					const log = queryAuditLog().filter((e) => e.targetRecordId === testDoc.id);
					expect(log.some((e) => e.action === 'update_document_title')).toBe(true);
					break;
				}
				case 'documents.getDocument': {
					const res = serviceModules.documents.getDocument(human, testDoc.id);
					expect(res?.id).toBe(testDoc.id);
					const log = queryAuditLog().filter((e) => e.targetRecordId === testDoc.id);
					expect(log.some((e) => e.action === 'get_document')).toBe(true);
					break;
				}
				case 'documents.listDocuments': {
					const list = serviceModules.documents.listDocuments(human);
					expect(list.some((d) => d.id === testDoc.id)).toBe(true);
					break;
				}
				case 'documents.deleteDocument': {
					const toDelete = serviceModules.documents.createDocument(human, { title: 'To Delete' });
					serviceModules.documents.deleteDocument(human, toDelete.id);
					const log = queryAuditLog().filter((e) => e.targetRecordId === toDelete.id);
					expect(log.some((e) => e.action === 'delete_document')).toBe(true);
					break;
				}
				case 'records.createRecord': {
					const r = serviceModules.records.createRecord(human, {
						parentId: testDoc.id,
						blockType: 'paragraph'
					});
					const log = queryAuditLog().filter((e) => e.targetRecordId === r.id);
					expect(log.some((e) => e.action === 'create_record')).toBe(true);
					break;
				}
				case 'records.writeRecord': {
					serviceModules.records.writeRecord(human, testBlock.id, {
						markdown: 'Updated text via human'
					});
					const log = queryAuditLog().filter((e) => e.targetRecordId === testBlock.id);
					expect(log.some((e) => e.action === 'write_record')).toBe(true);
					break;
				}
				case 'records.getRecord': {
					const r = serviceModules.records.getRecord(human, testBlock.id);
					expect(r?.id).toBe(testBlock.id);
					break;
				}
				case 'records.deleteRecord': {
					const r = serviceModules.records.createRecord(human, {
						parentId: testDoc.id,
						blockType: 'paragraph'
					});
					serviceModules.records.deleteRecord(human, r.id);
					const log = queryAuditLog().filter((e) => e.targetRecordId === r.id);
					expect(log.some((e) => e.action === 'delete_record')).toBe(true);
					break;
				}
				case 'holds.holdRecords': {
					const hold = serviceModules.holds.holdRecords(human, [testBlock.id]);
					expect(hold.granted).toContain(testBlock.id);
					const log = queryAuditLog();
					expect(log.some((e) => e.action === 'hold_records')).toBe(true);
					break;
				}
				case 'holds.releaseRecords': {
					serviceModules.holds.releaseRecords(human, [testBlock.id]);
					const log = queryAuditLog();
					expect(log.some((e) => e.action === 'release_records')).toBe(true);
					break;
				}
				case 'collections.createCollection': {
					const col = serviceModules.collections.createCollection(human, {
						title: 'Wiring Sub Col',
						schema: []
					});
					expect(col.id).toBeDefined();
					const log = queryAuditLog().filter((e) => e.targetRecordId === col.id);
					expect(log.some((e) => e.action === 'create_collection')).toBe(true);
					break;
				}
				case 'collections.listCollections': {
					const list = serviceModules.collections.listCollections(human);
					expect(list.some((c) => c.id === testCol.id)).toBe(true);
					break;
				}
				case 'collections.queryCollection': {
					const res = serviceModules.collections.queryCollection(human, testCol.id);
					expect(res.collection?.id).toBe(testCol.id);
					const log = queryAuditLog().filter((e) => e.targetRecordId === testCol.id);
					expect(log.some((e) => e.action === 'query_collection')).toBe(true);
					break;
				}
				case 'collections.updateCollectionTitle': {
					serviceModules.collections.updateCollectionTitle(human, testCol.id, 'Renamed Col');
					const log = queryAuditLog().filter((e) => e.targetRecordId === testCol.id);
					expect(log.some((e) => e.action === 'update_collection_title')).toBe(true);
					break;
				}
				case 'collections.deleteCollection': {
					const col = serviceModules.collections.createCollection(human, {
						title: 'To Delete Col',
						schema: []
					});
					serviceModules.collections.deleteCollection(human, col.id);
					const log = queryAuditLog().filter((e) => e.targetRecordId === col.id);
					expect(log.some((e) => e.action === 'delete_collection')).toBe(true);
					break;
				}
				case 'search.searchWorkspace': {
					const res = serviceModules.search.searchWorkspace(human, 'Manifest');
					expect(Array.isArray(res)).toBe(true);
					const log = queryAuditLog();
					expect(log.some((e) => e.action === 'search_workspace')).toBe(true);
					break;
				}
				case 'spaces.createSpace': {
					const space = serviceModules.spaces.createSpace(human, 'Manifest Wiring Space');
					expect(space.id).toBeDefined();
					const log = queryAuditLog().filter((e) => e.targetRecordId === space.id);
					expect(log.some((e) => e.action === 'create_space')).toBe(true);
					break;
				}
				case 'spaces.listSpaces': {
					const spaces = serviceModules.spaces.listSpaces();
					expect(Array.isArray(spaces)).toBe(true);
					break;
				}
				case 'tokens.createToken': {
					const { record } = serviceModules.tokens.createToken(human, {
						clientLabel: 'Manifest Wiring Token',
						allowedDocumentIds: [],
						allowedCollectionIds: [],
						allowedSpaceIds: []
					});
					const log = queryAuditLog().filter((e) => e.targetRecordId === record.tokenHash);
					expect(log.some((e) => e.action === 'create_token')).toBe(true);
					break;
				}
				case 'tokens.revokeToken': {
					const { record } = serviceModules.tokens.createToken(human, {
						clientLabel: 'Manifest Wiring Token To Revoke',
						allowedDocumentIds: [],
						allowedCollectionIds: [],
						allowedSpaceIds: []
					});
					serviceModules.tokens.revokeToken(human, record.tokenHash);
					const log = queryAuditLog().filter((e) => e.targetRecordId === record.tokenHash);
					expect(log.some((e) => e.action === 'revoke_token')).toBe(true);
					break;
				}
				case 'tokens.listTokens': {
					const tokens = serviceModules.tokens.listTokens();
					expect(Array.isArray(tokens)).toBe(true);
					break;
				}
				case 'audit.listAuditHistory': {
					const history = serviceModules.audit.listAuditHistory();
					expect(history.length).toBeGreaterThan(0);
					break;
				}
				default:
					throw new Error(`Unhandled ui: true manifest entry: ${method}`);
			}
		}
	});

	it('11. A real Yjs websocket client editing directly (no MCP/service call) is still audited exactly once per action (issue #34)', async () => {
		const yjs = harness.getYjsClient();

		// This mirrors exactly what the UI does today (src/routes/doc/[id]/+page.svelte,
		// BlockEditor.svelte): mutate the client's own Y.Doc directly via
		// src/lib/data/records.ts, with no service-layer/MCP call in the loop at
		// all. Only y-websocket sync carries it to the server. Before this
		// feature, the server-side audit_log had no way to know this ever
		// happened — see docs/specifications/audit-coverage.md.
		const docMeta = createDocument(yjs.doc, { title: 'Directly Edited Doc' });
		const block = createRecord(yjs.doc, { parentId: docMeta.id, blockType: 'paragraph' }, human);

		await harness.waitForCondition(() =>
			queryAuditLog().some((a) => a.action === 'create_document' && a.targetRecordId === docMeta.id)
		);
		await harness.waitForCondition(() =>
			queryAuditLog().some((a) => a.action === 'create_record' && a.targetRecordId === block.id)
		);
		expect(
			queryAuditLog().filter(
				(a) => a.action === 'create_document' && a.targetRecordId === docMeta.id
			)
		).toHaveLength(1);
		expect(
			queryAuditLog().filter((a) => a.action === 'create_record' && a.targetRecordId === block.id)
		).toHaveLength(1);

		const createEntry = queryAuditLog().find(
			(a) => a.action === 'create_record' && a.targetRecordId === block.id
		);
		expect(createEntry?.actor).toEqual({ kind: 'human', userId: 'local' });

		// Content edits are debounced (docs/specifications/audit-coverage.md §4) —
		// force the pending event to write immediately rather than waiting out
		// the real debounce window in this test.
		const ytext = getRecordYText(yjs.doc, block.id);
		await harness.waitForCondition(() => ytext !== undefined);
		yjs.doc.transact(() => ytext!.insert(0, 'edited directly by the UI'));
		// The editor updates the record's provenance projection alongside its
		// direct Y.Text write, so every client observes the same attribution.
		touchRecordEditor(yjs.doc, block.id, human);

		// Wait for the SERVER's own doc (not just the local client doc, which
		// updates instantly) to actually receive the sync before flushing —
		// otherwise there's nothing pending yet to flush.
		await harness.waitForCondition(() => {
			const serverText = getRecordYText(resolveWorkspaceContext().doc, block.id);
			const serverRecord = getRecord(resolveWorkspaceContext().doc, block.id);
			return (
				serverText !== undefined &&
				plainText(yTextToRichText(serverText)).length > 0 &&
				serverRecord?.lastEditedBy.kind === 'human' &&
				serverRecord.lastEditedBy.userId === 'brylie' &&
				serverRecord.lastEditedAt > block.createdAt
			);
		});
		flushPendingAuditEvents();
		expect(
			queryAuditLog().filter((a) => a.action === 'update_record' && a.targetRecordId === block.id)
		).toHaveLength(1);

		crdtDeleteRecord(yjs.doc, block.id);
		await harness.waitForCondition(() =>
			queryAuditLog().some((a) => a.action === 'delete_record' && a.targetRecordId === block.id)
		);
		expect(
			queryAuditLog().filter((a) => a.action === 'delete_record' && a.targetRecordId === block.id)
		).toHaveLength(1);
	});

	it('12. MCP create_record/write_record author and retarget a page_link, visible to a real Yjs client, with the permission boundary enforced for an independently scoped caller (issue #46)', async () => {
		const yjs = harness.getYjsClient();
		const targetA = createDocument(yjs.doc, { title: 'Target A' });
		const targetB = createDocument(yjs.doc, { title: 'Target B' });
		const source = createDocument(yjs.doc, { title: 'Source Doc' });
		const secret = createDocument(yjs.doc, { title: 'Secret Doc' });

		const { token } = harness.createToken({
			clientLabel: 'Linker Agent',
			allowedDocumentIds: [targetA.id, targetB.id, source.id],
			allowedCollectionIds: []
		});

		const mcp = await harness.getMcpClient(token);

		// 1st call: create a page_link block with its target set in the same call.
		const createRes = await mcp.callTool({
			name: 'create_record',
			arguments: {
				parentId: source.id,
				blockType: 'page_link',
				referencedRecordId: targetA.id
			}
		});
		const blockId = parseMcpText<{ recordId: string }>(createRes).recordId;

		// The real Yjs websocket client (standing in for the browser UI) observes
		// the referencedRecordId this MCP call set, with no separate write.
		await harness.waitForCondition(() => {
			const record = getRecord(yjs.doc, blockId);
			return record?.referencedRecordId === targetA.id;
		});

		// 2nd, independent MCP client + call: retarget via write_record's named
		// field, not Markdown — proves the retarget isn't tied to the same
		// in-process call/connection that created the block.
		const mcp2 = await harness.getMcpClient(token);
		const retargetRes = await mcp2.callTool({
			name: 'write_record',
			arguments: { recordId: blockId, referencedRecordId: targetB.id }
		});
		expect(retargetRes.isError).toBeFalsy();

		await harness.waitForCondition(() => {
			const record = getRecord(yjs.doc, blockId);
			return record?.referencedRecordId === targetB.id;
		});

		// A third, independently scoped caller (no access to `secret`) cannot
		// retarget the link there — the permission boundary applies to a
		// metadata-only write exactly like a content write.
		const { token: scopedToken } = harness.createToken({
			clientLabel: 'Scoped Retargeter',
			allowedDocumentIds: [source.id, targetB.id],
			allowedCollectionIds: []
		});
		const mcp3 = await harness.getMcpClient(scopedToken);
		const deniedRes = await mcp3.callTool({
			name: 'write_record',
			arguments: { recordId: blockId, referencedRecordId: secret.id }
		});
		expect(deniedRes.isError).toBe(true);
		expect(getResultText(deniedRes)).not.toContain('Secret Doc');

		// The rejected retarget left the link pointing at targetB, unchanged.
		const record = getRecord(yjs.doc, blockId);
		expect(record?.referencedRecordId).toBe(targetB.id);
	});

	it('13. MCP create_record accepts blockType: collection_view (previously rejected by the schema itself), sets referencedRecordId + viewConfig in one call, and write_record retargets/reconfigures it, with the permission and kind boundaries enforced (issue #37)', async () => {
		const yjs = harness.getYjsClient();
		const targetA = createCollection(yjs.doc, { title: 'Tasks A', schema: [] });
		const targetB = createCollection(yjs.doc, { title: 'Tasks B', schema: [] });
		const docTarget = createDocument(yjs.doc, { title: 'Not A Collection' });
		const secretCollection = createCollection(yjs.doc, { title: 'Secret Tasks', schema: [] });
		const source = createDocument(yjs.doc, { title: 'Source Doc' });

		const { token } = harness.createToken({
			clientLabel: 'Embed Agent',
			allowedDocumentIds: [source.id],
			allowedCollectionIds: [targetA.id, targetB.id]
		});

		const mcp = await harness.getMcpClient(token);

		// 1st call: create + configure a collection_view block in one call. Before
		// issue #37, 'collection_view' wasn't even in the MCP blockType schema, so
		// this call would be rejected by protocol-level zod validation before ever
		// reaching service-layer code.
		const createRes = await mcp.callTool({
			name: 'create_record',
			arguments: {
				parentId: source.id,
				blockType: 'collection_view',
				referencedRecordId: targetA.id,
				viewConfig: { viewType: 'table' }
			}
		});
		expect(createRes.isError).toBeFalsy();
		const blockId = parseMcpText<{ recordId: string }>(createRes).recordId;

		await harness.waitForCondition(() => {
			const record = getRecord(yjs.doc, blockId);
			return record?.referencedRecordId === targetA.id && record?.viewConfig?.viewType === 'table';
		});

		// 2nd, independent MCP client + call: retarget and reconfigure via
		// write_record's named fields.
		const mcp2 = await harness.getMcpClient(token);
		const writeRes = await mcp2.callTool({
			name: 'write_record',
			arguments: {
				recordId: blockId,
				referencedRecordId: targetB.id,
				viewConfig: { viewType: 'board', groupBy: 'status' }
			}
		});
		expect(writeRes.isError).toBeFalsy();

		await harness.waitForCondition(() => {
			const record = getRecord(yjs.doc, blockId);
			return record?.referencedRecordId === targetB.id && record?.viewConfig?.viewType === 'board';
		});

		// Rejected: target resolves to a Document, not a Collection.
		const wrongKindRes = await mcp2.callTool({
			name: 'write_record',
			arguments: { recordId: blockId, referencedRecordId: docTarget.id }
		});
		expect(wrongKindRes.isError).toBe(true);

		// Rejected: target outside the caller's granted Collections, without
		// leaking whether it exists.
		const deniedRes = await mcp2.callTool({
			name: 'write_record',
			arguments: { recordId: blockId, referencedRecordId: secretCollection.id }
		});
		expect(deniedRes.isError).toBe(true);
		expect(getResultText(deniedRes)).not.toContain('Secret Tasks');

		// Neither rejected retarget mutated the block — still pointing at targetB.
		const record = getRecord(yjs.doc, blockId);
		expect(record?.referencedRecordId).toBe(targetB.id);
	});
});
