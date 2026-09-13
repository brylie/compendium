import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './harness';
import { queryAuditLogForSpace } from '$lib/server/audit';
import {
	createSpace,
	recordCatalogDocumentCreated,
	reserveDocumentLocator
} from '$lib/server/catalog';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { createDocument, getResultText, parseMcpText } from './mcp-parity-helpers';

describe('Permissions & Token Grants', () => {
	let harness: TestHarness;

	beforeEach(async () => {
		harness = await createTestHarness();
	});

	afterEach(async () => {
		await harness?.cleanup();
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
	it("3d-2. MCP create_record on a Document in a non-default Space attributes the resulting record's audit history to that Space, not the workspace's first Space (PR #284/#289 review regression)", async () => {
		// No MCP tool lets a caller choose a Space when creating a Document
		// (that's #6's still-unbuilt surface) — Space B's Document is
		// constructed the same way test 3d's fixture is, via the raw
		// data/catalog primitives. create_record itself, the thing actually
		// under test, goes through the real MCP transport.
		const { workspaceId, defaultSpaceId: spaceAId } = resolveWorkspaceContext();
		const spaceB = createSpace(workspaceId, 'Space B');

		const docBShard = resolveWorkspaceContext({ workspaceId, shardId: 'tier-a-3d-2-space-b-doc' });
		const docB = createDocument(docBShard.doc, {
			id: 'tier-a-3d-2-space-b-doc',
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
			clientLabel: 'Space B Writer',
			allowedDocumentIds: [docB.id],
			allowedCollectionIds: []
		});
		const mcp = await harness.getMcpClient(token);

		const createRes = await mcp.callTool({
			name: 'create_record',
			arguments: { parentId: docB.id, blockType: 'paragraph' }
		});
		const record = parseMcpText<{ recordId: string }>(createRes);

		const spaceBEntries = queryAuditLogForSpace(workspaceId, spaceB.id, {
			targetRecordId: record.recordId
		});
		expect(spaceBEntries.some((e) => e.targetRecordId === record.recordId)).toBe(true);

		const spaceAEntries = queryAuditLogForSpace(workspaceId, spaceAId, {
			targetRecordId: record.recordId
		});
		expect(spaceAEntries.some((e) => e.targetRecordId === record.recordId)).toBe(false);
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
});
