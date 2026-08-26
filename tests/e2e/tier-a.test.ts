import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './harness';
import { createDocument, createRecord, getRecord, getRecordYText } from '$lib/data/records';
import { getAwareness } from '$lib/server/awareness';
import { queryAuditLog } from '$lib/server/audit';
import { plainText, yTextToRichText } from '$lib/data/richtext';
import { serviceModules, serviceSurfaces } from '$lib/services/manifest';
import { flushPendingAuditEvents } from '$lib/server/audit-observer';
import { getYDoc } from '$lib/server/ydoc';
import { deleteRecord as crdtDeleteRecord } from '$lib/data/records';
import type { ActorId } from '$lib/data/types';

const human: ActorId = { kind: 'human', userId: 'brylie' };

function parseMcpText<T = unknown>(result: unknown): T {
	const r = result as { content?: Array<{ text?: string }>; isError?: boolean };
	if (r.isError) {
		const text = r.content?.[0]?.text ?? 'Unknown error';
		throw new Error(`MCP Error: ${text}`);
	}
	const text = r.content?.[0]?.text ?? '';
	return text ? (JSON.parse(text) as T) : (null as unknown as T);
}

function getResultText(result: unknown): string {
	const r = result as { content?: Array<{ text?: string }> };
	return r.content?.[0]?.text ?? '';
}

describe('Tier A: Protocol-Level MCP & Yjs E2E Parity', () => {
	let harness: TestHarness;

	beforeEach(async () => {
		harness = await createTestHarness();
	});

	afterEach(async () => {
		await harness.cleanup();
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
				const data = parseMcpText<{ records: Array<{ id: string; markdown: string }> }>(res);
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
			const states = Array.from(getAwareness().getStates().values()) as Array<{
				heldRecordIds?: string[];
			}>;
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
			const states = Array.from(getAwareness().getStates().values()) as Array<{
				heldRecordIds?: string[];
			}>;
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
		const methods = Object.keys(serviceSurfaces) as Array<keyof typeof serviceSurfaces>;
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

		// Wait for the SERVER's own doc (not just the local client doc, which
		// updates instantly) to actually receive the sync before flushing —
		// otherwise there's nothing pending yet to flush.
		await harness.waitForCondition(() => {
			const serverText = getRecordYText(getYDoc(), block.id);
			return serverText !== undefined && plainText(yTextToRichText(serverText)).length > 0;
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
});
