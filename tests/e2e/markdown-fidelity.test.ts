import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './harness';
import { getRecord, getRecordYText } from '$lib/data/record-ops';
import { plainText, yTextToRichText } from '$lib/data/richtext';
import { createDocument, getResultText, parseMcpText } from './mcp-parity-helpers';

describe('Markdown & Content Fidelity', () => {
	let harness: TestHarness;

	beforeEach(async () => {
		harness = await createTestHarness();
	});

	afterEach(async () => {
		await harness?.cleanup();
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
	it('16. MCP create_record builds a columns block, a caller can populate a nested column via a token scoped only to the owning Document (issue #148), and get_document exposes it as nested children plus fenced markdown', async () => {
		const yjs = harness.getYjsClient();
		const doc = createDocument(yjs.doc, { title: 'Layout Doc' });

		const { token } = harness.createToken({
			clientLabel: 'Layout Agent',
			allowedDocumentIds: [doc.id],
			allowedCollectionIds: []
		});
		const mcp = await harness.getMcpClient(token);

		const createColumnsRes = await mcp.callTool({
			name: 'create_record',
			arguments: { parentId: doc.id, blockType: 'columns', columnCount: 3 }
		});
		expect(createColumnsRes.isError).toBeFalsy();
		const columnsId = parseMcpText<{ recordId: string }>(createColumnsRes).recordId;

		// The real Yjs client (standing in for the browser UI) converges on the
		// full container structure this one MCP call produced: the columns
		// block plus 3 columns, each pre-seeded with one empty paragraph.
		await harness.waitForCondition(() => {
			const record = getRecord(yjs.doc, columnsId);
			return record?.childRecordIds?.length === 3;
		});
		const columnIds = getRecord(yjs.doc, columnsId)!.childRecordIds!;
		for (const columnId of columnIds) {
			expect(getRecord(yjs.doc, columnId)?.childRecordIds).toHaveLength(1);
		}

		// A column's own id was never granted to the token directly — only the
		// owning Document was. create_record must still resolve access up to
		// that Document (resolveOwningParentId) rather than rejecting the
		// column id as an unrecognized parent.
		const [columnAId] = columnIds;
		const headingRes = await mcp.callTool({
			name: 'create_record',
			arguments: { parentId: columnAId, blockType: 'heading_2' }
		});
		expect(headingRes.isError).toBeFalsy();
		const headingId = parseMcpText<{ recordId: string }>(headingRes).recordId;

		// Writing content to that nested block also requires only the
		// Document-level grant — hold_records/write_record resolve the same
		// owning-Document permission check.
		const holdRes = await mcp.callTool({
			name: 'hold_records',
			arguments: { recordIds: [headingId] }
		});
		expect(parseMcpText<{ granted: string[] }>(holdRes).granted).toContain(headingId);
		const writeRes = await mcp.callTool({
			name: 'write_record',
			arguments: { recordId: headingId, markdown: 'Column heading' }
		});
		expect(writeRes.isError).toBeFalsy();

		await harness.waitForCondition(() => {
			const ytext = getRecordYText(yjs.doc, headingId);
			return !!ytext && plainText(yTextToRichText(ytext)).includes('Column heading');
		});

		// get_document exposes the nested structure generically (`children`)
		// and folds it into fenced-div markdown on the columns block itself.
		const getRes = await mcp.callTool({
			name: 'get_document',
			arguments: { documentId: doc.id }
		});
		const data = parseMcpText<{
			records: { id: string; blockType?: string; markdown: string; children?: unknown[] }[];
		}>(getRes);
		expect(data.records).toHaveLength(1); // only the columns block is top-level
		const columnsView = data.records[0];
		expect(columnsView.blockType).toBe('columns');
		expect(columnsView.children).toHaveLength(3);
		expect(columnsView.markdown).toContain('::: columns');
		expect(columnsView.markdown).toContain('Column heading');

		// A token with no access to this Document at all is still denied when
		// targeting the column id directly — the ancestor-walk resolves
		// access, it does not bypass it.
		const { token: outsiderToken } = harness.createToken({
			clientLabel: 'Outsider Agent',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});
		const mcpOutsider = await harness.getMcpClient(outsiderToken);
		const deniedRes = await mcpOutsider.callTool({
			name: 'create_record',
			arguments: { parentId: columnAId, blockType: 'paragraph' }
		});
		expect(deniedRes.isError).toBe(true);
		expect(getResultText(deniedRes)).toContain('Permission denied');
	});
});
