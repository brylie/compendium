import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './harness';
import {
	createRecord,
	deleteRecord as crdtDeleteRecord,
	getRecord,
	getRecordYText,
	touchRecordEditor
} from '$lib/data/record-ops';
import { queryAuditLog } from '$lib/server/audit';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { plainText, yTextToRichText } from '$lib/data/richtext';
import { flushPendingAuditEvents } from '$lib/server/audit-observer';
import { LOCAL_UI_ORIGIN, transactWithOrigin } from '$lib/mutation-origin';
import { createDocument, human, parseMcpText } from './mcp-parity-helpers';

describe('Holds & Audit Attribution', () => {
	let harness: TestHarness;

	beforeEach(async () => {
		harness = await createTestHarness();
	});

	afterEach(async () => {
		await harness?.cleanup();
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

		transactWithOrigin(yjs.doc, LOCAL_UI_ORIGIN, () => crdtDeleteRecord(yjs.doc, block.id));
		await harness.waitForCondition(() =>
			queryAuditLog().some((a) => a.action === 'delete_record' && a.targetRecordId === block.id)
		);
		expect(
			queryAuditLog().filter((a) => a.action === 'delete_record' && a.targetRecordId === block.id)
		).toHaveLength(1);
	});
});
