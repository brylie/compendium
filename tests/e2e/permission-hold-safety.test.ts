import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './harness';
import { getResultText, human, parseMcpText } from './mcp-parity-helpers';
import { createDocument as createServiceDocument } from '$lib/services/documents';
import { createRecord as createServiceRecord } from '$lib/services/records';
import { resolveRequestContext } from '$lib/server/request-context';
import { getRecord } from '$lib/data/record-ops';
import { plainText } from '$lib/data/richtext';
import { createDocument as createRawDocument } from '$lib/data/document-ops';
import { createCollection as createRawCollection } from '$lib/data/collection-ops';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { createSpace, resolveShardForParent } from '$lib/server/catalog';
import { queryAuditLog } from '$lib/server/audit';
import { aggregateHolds } from '$lib/server/holds';
import { TEST_ORIGIN, transactWithOrigin } from '$lib/mutation-origin';
import * as Y from 'yjs';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

interface HoldResult {
	granted: string[];
	denied: string[];
}

function recordText(doc: Y.Doc, recordId: string) {
	const content = getRecord(doc, recordId)?.content;
	return content ? plainText(content) : undefined;
}

async function createBlock(mcp: Client, parentId: string, blockType = 'paragraph') {
	return parseMcpText<{ recordId: string }>(
		await mcp.callTool({ name: 'create_record', arguments: { parentId, blockType } })
	).recordId;
}

async function hold(mcp: Client, recordIds: string[]) {
	return parseMcpText<HoldResult>(
		await mcp.callTool({ name: 'hold_records', arguments: { recordIds } })
	);
}

describe('Permission and hold safety across protocols', () => {
	let harness: TestHarness;
	beforeEach(async () => {
		harness = await createTestHarness();
	});
	afterEach(async () => {
		await harness?.cleanup();
	});

	it.each(['columns', 'toggle'] as const)(
		'scopes %s descendants to their owning Document through MCP and WebSocket',
		async (blockType) => {
			const document = createServiceDocument(resolveRequestContext(human), {
				title: `${blockType} permission fixture`
			});
			const yjs = harness.getYjsClient({ room: `shard-${document.id}`, disableBc: true });
			const { token } = harness.createToken({
				clientLabel: 'Nested writer',
				allowedDocumentIds: [document.id],
				allowedCollectionIds: []
			});
			const { token: outsiderToken } = harness.createToken({
				clientLabel: 'Nested outsider',
				allowedDocumentIds: [],
				allowedCollectionIds: []
			});
			const mcp = await harness.getMcpClient(token);
			const outsider = await harness.getMcpClient(outsiderToken);
			const containerId = await createBlock(mcp, document.id, blockType);
			await harness.waitForCondition(() => getRecord(yjs.doc, containerId) !== undefined);
			const parentId =
				blockType === 'columns' ? getRecord(yjs.doc, containerId)!.childRecordIds![0] : containerId;
			const childId = await createBlock(mcp, parentId);
			await harness.waitForCondition(() => getRecord(yjs.doc, childId)?.parentId === parentId);

			// Unauthorized holds are audited even if the hold engine sees contention.
			expect(await hold(mcp, [childId])).toEqual({ granted: [childId], denied: [] });
			await harness.waitForCondition(
				() => aggregateHolds(yjs.awareness).get(childId)?.kind === 'human-via-client'
			);
			const before = getRecord(yjs.doc, parentId)!.childRecordIds;
			const serverDoc = resolveWorkspaceContext({ shardId: document.id }).doc;
			const stateBeforeDenials = Y.encodeStateAsUpdate(serverDoc);
			for (const [name, args] of [
				['create_record', { parentId, blockType: 'paragraph' }],
				['write_record', { recordId: childId, markdown: 'unauthorized replacement' }],
				['delete_record', { recordId: childId }]
			] as const) {
				const result = await outsider.callTool({ name, arguments: args });
				expect(result.isError).toBe(true);
				expect(getResultText(result)).toContain('Permission denied');
			}
			expect(await hold(outsider, [childId])).toEqual({ granted: [], denied: [childId] });
			expect(Y.encodeStateAsUpdate(serverDoc)).toEqual(stateBeforeDenials);
			expect(getRecord(yjs.doc, parentId)!.childRecordIds).toEqual(before);
			expect(recordText(yjs.doc, childId)).toBe('');
			expect(
				aggregateHolds(resolveWorkspaceContext({ shardId: document.id }).awareness).get(childId)
			).toMatchObject({ client: 'Nested writer' });
			const denials = queryAuditLog().filter((e) => e.action === 'hold_records_denied');
			expect(denials).toHaveLength(1);
			expect(denials[0]).toMatchObject({
				targetRecordId: document.id,
				actor: { client: 'Nested outsider' }
			});
			expect(denials[0].diff).toBeUndefined();

			// A separate request must see the grant and hold established earlier.
			const freshMcp = await harness.getMcpClient(token);
			expect(
				(
					await freshMcp.callTool({
						name: 'write_record',
						arguments: { recordId: childId, markdown: 'Nested agent edit' }
					})
				).isError
			).toBeFalsy();
			await harness.waitForCondition(() => recordText(yjs.doc, childId) === 'Nested agent edit');
			expect(
				(await freshMcp.callTool({ name: 'release_records', arguments: { recordIds: [childId] } }))
					.isError
			).toBeFalsy();
			await harness.waitForCondition(() => !aggregateHolds(yjs.awareness).has(childId));

			// Human focus in the same nested block is also honored by the agent.
			yjs.awareness.setLocalState({ actor: human, heldRecordIds: [childId] });
			await harness.waitForCondition(
				() =>
					aggregateHolds(resolveWorkspaceContext({ shardId: document.id }).awareness).get(childId)
						?.kind === 'human'
			);
			expect(await hold(freshMcp, [childId])).toEqual({ granted: [], denied: [childId] });
			expect(queryAuditLog().filter((e) => e.action === 'hold_records_denied')).toHaveLength(1);
			yjs.awareness.setLocalState(null);
			await harness.waitForCondition(
				() =>
					!aggregateHolds(resolveWorkspaceContext({ shardId: document.id }).awareness).has(childId)
			);
			expect(await hold(freshMcp, [childId])).toEqual({ granted: [childId], denied: [] });
			expect(
				(await freshMcp.callTool({ name: 'delete_record', arguments: { recordId: childId } }))
					.isError
			).toBeFalsy();
			await harness.waitForCondition(() => getRecord(yjs.doc, childId) === undefined);
			expect(getRecord(yjs.doc, parentId)!.childRecordIds).not.toContain(childId);
		}
	);

	it('does not apply the default-Space fallback to cataloged content in another Space', async () => {
		const context = resolveRequestContext(human);
		const otherSpace = createSpace(context.workspaceId, 'Cataloged other Space');
		const document = createServiceDocument(context, {
			title: 'Other Space document',
			spaceId: otherSpace.id
		});
		const block = createServiceRecord(context, { parentId: document.id, blockType: 'paragraph' });
		const yjs = harness.getYjsClient({ room: `shard-${document.id}`, disableBc: true });
		await harness.waitForCondition(() => getRecord(yjs.doc, block.id) !== undefined);
		const { token } = harness.createToken({
			clientLabel: 'Default-Space only',
			allowedDocumentIds: [],
			allowedCollectionIds: [],
			allowedSpaceIds: [context.workspace.defaultSpaceId]
		});
		const mcp = await harness.getMcpClient(token);
		const server = resolveWorkspaceContext({ shardId: document.id });
		const before = Y.encodeStateAsUpdate(server.doc);
		for (const [name, args] of [
			['create_record', { parentId: document.id, blockType: 'paragraph' }],
			['write_record', { recordId: block.id, markdown: 'Forbidden' }],
			['delete_record', { recordId: block.id }]
		] as const) {
			const result = await mcp.callTool({ name, arguments: args });
			expect(result.isError).toBe(true);
			expect(getResultText(result)).toContain('Permission denied');
		}
		expect(await hold(mcp, [block.id])).toEqual({ granted: [], denied: [block.id] });
		expect(Y.encodeStateAsUpdate(server.doc)).toEqual(before);
		expect(aggregateHolds(server.awareness).has(block.id)).toBe(false);
	});

	it.each(['Document', 'Collection'] as const)(
		'honors only default-Space grants for an uncataloged %s',
		async (kind) => {
			const workspace = resolveWorkspaceContext();
			// Direct primitive creation after context bootstrap leaves the parent uncataloged.
			const parent = transactWithOrigin(workspace.doc, TEST_ORIGIN, () =>
				kind === 'Document'
					? createRawDocument(workspace.doc, { title: 'Legacy document' })
					: createRawCollection(workspace.doc, {
							title: 'Legacy collection',
							schema: [{ key: 'name', label: 'Name', type: 'text' }]
						})
			);
			expect(resolveShardForParent(workspace.workspaceId, parent.id)).toBeUndefined();
			const yjs = harness.getYjsClient({ disableBc: true });
			const { token } = harness.createToken({
				clientLabel: 'Default-Space writer',
				allowedDocumentIds: [],
				allowedCollectionIds: [],
				allowedSpaceIds: [workspace.defaultSpaceId]
			});
			const mcp = await harness.getMcpClient(token);
			const recordId = parseMcpText<{ recordId: string }>(
				await mcp.callTool({
					name: 'create_record',
					arguments:
						kind === 'Document'
							? { parentId: parent.id, blockType: 'paragraph' }
							: { parentId: parent.id, properties: { name: { type: 'text', value: 'Original' } } }
				})
			).recordId;
			await harness.waitForCondition(() => getRecord(yjs.doc, recordId) !== undefined);
			expect(await hold(mcp, [recordId])).toEqual({ granted: [recordId], denied: [] });
			await harness.waitForCondition(() => aggregateHolds(yjs.awareness).has(recordId));

			const stateBeforeDenials = Y.encodeStateAsUpdate(workspace.doc);
			const otherSpace = createSpace(workspace.workspaceId, 'Other Space');
			for (const allowedSpaceIds of [[], [otherSpace.id]]) {
				const { token: deniedToken } = harness.createToken({
					clientLabel: 'Legacy outsider',
					allowedDocumentIds: [],
					allowedCollectionIds: [],
					allowedSpaceIds
				});
				const outsider = await harness.getMcpClient(deniedToken);
				for (const [name, args] of [
					['create_record', { parentId: parent.id }],
					[
						'write_record',
						{
							recordId,
							...(kind === 'Document'
								? { markdown: 'Forbidden' }
								: { properties: { name: { type: 'text', value: 'Forbidden' } } })
						}
					],
					['delete_record', { recordId }]
				] as const) {
					const result = await outsider.callTool({ name, arguments: args });
					expect(result.isError).toBe(true);
					expect(getResultText(result)).toContain('Permission denied');
				}
				expect(await hold(outsider, [recordId])).toEqual({ granted: [], denied: [recordId] });
			}
			expect(Y.encodeStateAsUpdate(workspace.doc)).toEqual(stateBeforeDenials);
			expect(getRecord(yjs.doc, recordId)).toMatchObject(
				kind === 'Document'
					? { content: { runs: [] } }
					: { properties: { name: { type: 'text', value: 'Original' } } }
			);
			expect(aggregateHolds(workspace.awareness).get(recordId)).toMatchObject({
				client: 'Default-Space writer'
			});
			const freshMcp = await harness.getMcpClient(token);
			expect(
				(
					await freshMcp.callTool({
						name: 'write_record',
						arguments: {
							recordId,
							...(kind === 'Document'
								? { markdown: 'Legacy edit' }
								: { properties: { name: { type: 'text', value: 'Legacy edit' } } })
						}
					})
				).isError
			).toBeFalsy();
			await harness.waitForCondition(() =>
				kind === 'Document'
					? recordText(yjs.doc, recordId) === 'Legacy edit'
					: getRecord(yjs.doc, recordId)?.properties?.name.value === 'Legacy edit'
			);
			expect(
				(await freshMcp.callTool({ name: 'delete_record', arguments: { recordId } })).isError
			).toBeFalsy();
			await harness.waitForCondition(() => getRecord(yjs.doc, recordId) === undefined);
			expect(resolveShardForParent(workspace.workspaceId, parent.id)).toBeUndefined();
		}
	);
});
