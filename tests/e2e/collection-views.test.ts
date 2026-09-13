import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './harness';
import { createCollection } from '$lib/data/collection-ops';
import { getRecord, patchRecordViewConfig } from '$lib/data/record-ops';
import { createDocument, getResultText, human, parseMcpText } from './mcp-parity-helpers';

describe('Collection View Config', () => {
	let harness: TestHarness;

	beforeEach(async () => {
		harness = await createTestHarness();
	});

	afterEach(async () => {
		await harness?.cleanup();
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
			return (
				record?.referencedRecordId === targetB.id &&
				record?.viewConfig?.viewType === 'board' &&
				record?.viewConfig?.groupBy === 'status'
			);
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
	it('14. MCP write_record viewConfigPatch merges only the named members over the real MCP transport, leaving a concurrently-set member untouched, and clears a member sent as JSON null (issue #195)', async () => {
		const yjs = harness.getYjsClient();
		const target = createCollection(yjs.doc, { title: 'Tasks', schema: [] });
		const source = createDocument(yjs.doc, { title: 'Source Doc' });

		const { token } = harness.createToken({
			clientLabel: 'Patch Agent',
			allowedDocumentIds: [source.id],
			allowedCollectionIds: [target.id]
		});

		const mcp = await harness.getMcpClient(token);

		const createRes = await mcp.callTool({
			name: 'create_record',
			arguments: {
				parentId: source.id,
				blockType: 'collection_view',
				referencedRecordId: target.id,
				viewConfig: { viewType: 'board', groupBy: 'status', visibleProperties: ['status'] }
			}
		});
		expect(createRes.isError).toBeFalsy();
		const blockId = parseMcpText<{ recordId: string }>(createRes).recordId;

		await harness.waitForCondition(
			() => getRecord(yjs.doc, blockId)?.viewConfig?.viewType === 'board'
		);

		// A concurrent actor (another agent call, or a human's Save) sets `sort`
		// directly, in between the block's creation and this patch call — the
		// bug issue #195 fixes is a whole-value viewConfig write silently
		// discarding a member like this one that it never meant to touch.
		patchRecordViewConfig(yjs.doc, blockId, { sort: { mode: 'manual' } }, human);

		// `yjs.doc` is this test's own y-websocket client, a separate replica
		// from the server's Y.Doc the MCP call below actually mutates — the
		// edit above is only local until it syncs over the wire. Without
		// waiting for the server to have observed it first, the write_record
		// call below could race ahead of that sync, making the assertion below
		// pass on eventual CRDT convergence alone rather than actually proving
		// this patch call left a concurrently-set member untouched.
		await harness.waitForCondition(async () => {
			const res = await mcp.callTool({
				name: 'get_document',
				arguments: { documentId: source.id }
			});
			const data = parseMcpText<{
				records: { id: string; viewConfig?: { sort?: { mode: string } } }[];
			}>(res);
			return data.records.find((r) => r.id === blockId)?.viewConfig?.sort?.mode === 'manual';
		});

		const patchRes = await mcp.callTool({
			name: 'write_record',
			arguments: {
				recordId: blockId,
				// `visibleProperties: null` clears that member over the wire —
				// JSON has no way to send "the key undefined" directly, so the
				// MCP schema uses null to stand in for it (see
				// normalizeViewConfigPatch in src/lib/mcp/server.ts).
				viewConfigPatch: { groupBy: 'priority', visibleProperties: null }
			}
		});
		expect(patchRes.isError).toBeFalsy();

		await harness.waitForCondition(
			() => getRecord(yjs.doc, blockId)?.viewConfig?.groupBy === 'priority'
		);

		const record = getRecord(yjs.doc, blockId);
		expect(record?.viewConfig).toEqual({
			viewType: 'board',
			groupBy: 'priority',
			sort: { mode: 'manual' }
		});

		// Rejected: viewConfigPatch on a collection_view block with no
		// viewConfig yet — use viewConfig for the initial configure.
		const unconfiguredRes = await mcp.callTool({
			name: 'create_record',
			arguments: {
				parentId: source.id,
				blockType: 'collection_view',
				referencedRecordId: target.id
			}
		});
		const unconfiguredId = parseMcpText<{ recordId: string }>(unconfiguredRes).recordId;
		const rejectedRes = await mcp.callTool({
			name: 'write_record',
			arguments: { recordId: unconfiguredId, viewConfigPatch: { groupBy: 'status' } }
		});
		expect(rejectedRes.isError).toBe(true);

		// Rejected: viewConfig and viewConfigPatch together in the same call.
		const bothRes = await mcp.callTool({
			name: 'write_record',
			arguments: {
				recordId: blockId,
				viewConfig: { viewType: 'table' },
				viewConfigPatch: { groupBy: 'status' }
			}
		});
		expect(bothRes.isError).toBe(true);
	});
	it("15. MCP create_record/write_record set, whole-value-clear, patch, and patch-clear a collection_view block's swimlaneBy, round-tripping through get_document the same way groupBy already does (issue #219)", async () => {
		const yjs = harness.getYjsClient();
		const target = createCollection(yjs.doc, { title: 'Tasks', schema: [] });
		const source = createDocument(yjs.doc, { title: 'Source Doc' });

		const { token } = harness.createToken({
			clientLabel: 'Swimlane Agent',
			allowedDocumentIds: [source.id],
			allowedCollectionIds: [target.id]
		});

		const mcp = await harness.getMcpClient(token);

		async function readViewConfig(blockId: string) {
			const res = await mcp.callTool({
				name: 'get_document',
				arguments: { documentId: source.id }
			});
			const data = parseMcpText<{
				records: { id: string; viewConfig?: Record<string, unknown> }[];
			}>(res);
			return data.records.find((r) => r.id === blockId)?.viewConfig;
		}

		// create_record's viewConfig accepts swimlaneBy alongside groupBy in the
		// same call — before issue #219 the MCP schema silently stripped it.
		const createRes = await mcp.callTool({
			name: 'create_record',
			arguments: {
				parentId: source.id,
				blockType: 'collection_view',
				referencedRecordId: target.id,
				viewConfig: { viewType: 'board', groupBy: 'status', swimlaneBy: 'priority' }
			}
		});
		expect(createRes.isError).toBeFalsy();
		const blockId = parseMcpText<{ recordId: string }>(createRes).recordId;

		await harness.waitForCondition(
			async () => (await readViewConfig(blockId))?.swimlaneBy === 'priority'
		);

		// write_record's whole-value viewConfig clears swimlaneBy when the new
		// value omits it, same as any other member.
		const clearWholeRes = await mcp.callTool({
			name: 'write_record',
			arguments: {
				recordId: blockId,
				viewConfig: { viewType: 'board', groupBy: 'status' }
			}
		});
		expect(clearWholeRes.isError).toBeFalsy();

		await harness.waitForCondition(
			async () => (await readViewConfig(blockId))?.swimlaneBy === undefined
		);

		// viewConfigPatch sets swimlaneBy without disturbing groupBy.
		const patchSetRes = await mcp.callTool({
			name: 'write_record',
			arguments: {
				recordId: blockId,
				viewConfigPatch: { swimlaneBy: 'assignee' }
			}
		});
		expect(patchSetRes.isError).toBeFalsy();

		await harness.waitForCondition(
			async () => (await readViewConfig(blockId))?.swimlaneBy === 'assignee'
		);
		expect((await readViewConfig(blockId))?.groupBy).toBe('status');

		// viewConfigPatch's `swimlaneBy: null` clears it explicitly, leaving
		// groupBy untouched — the same omitted-vs-undefined convention
		// normalizeViewConfigPatch already applies to groupBy.
		const patchClearRes = await mcp.callTool({
			name: 'write_record',
			arguments: {
				recordId: blockId,
				viewConfigPatch: { swimlaneBy: null }
			}
		});
		expect(patchClearRes.isError).toBeFalsy();

		await harness.waitForCondition(
			async () => (await readViewConfig(blockId))?.swimlaneBy === undefined
		);
		expect((await readViewConfig(blockId))?.groupBy).toBe('status');
	});
});
