import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './server';
import { createToken } from './tokens';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { createCollection, createDocument, createRecord, setPrimaryField } from '$lib/data/records';

interface ToolHolder {
	_registeredTools: Record<
		string,
		{
			execute?: (
				args: Record<string, unknown>,
				extra: { authInfo: { token: string } }
			) => Promise<CallToolResult>;
			handler?: (
				args: Record<string, unknown>,
				extra: { authInfo: { token: string } }
			) => Promise<CallToolResult>;
			callback?: (
				args: Record<string, unknown>,
				extra: { authInfo: { token: string } }
			) => Promise<CallToolResult>;
		}
	>;
}

async function invokeTool(
	mcpServer: ReturnType<typeof createMcpServer>,
	toolName: string,
	args: Record<string, unknown>,
	token: string
): Promise<CallToolResult> {
	const serverWithTools = mcpServer as unknown as ToolHolder;
	const registeredTool = serverWithTools._registeredTools[toolName];
	if (!registeredTool) throw new Error(`Tool ${toolName} not registered`);
	const fn = registeredTool.execute ?? registeredTool.handler ?? registeredTool.callback;
	if (!fn) throw new Error(`Tool ${toolName} has no execution handler`);
	return fn.call(registeredTool, args, { authInfo: { token } });
}

function getTextContent(result: CallToolResult): string {
	const first = result.content[0];
	if (first && first.type === 'text') return first.text;
	return '';
}

describe('mcp server: document hierarchy and access grant persistence', () => {
	it('persists access grants for agent-created documents across fresh tool calls', async () => {
		const { doc } = resolveWorkspaceContext();
		const rootDoc = createDocument(doc, { title: 'Engineering Handbook' });

		// Create a token scoped only to the root document
		const { token } = createToken({
			clientLabel: 'Claude Desktop',
			allowedDocumentIds: [rootDoc.id],
			allowedCollectionIds: []
		});

		const mcpServer = createMcpServer();

		// 1. Agent calls create_document to create a child page
		const createResult = await invokeTool(
			mcpServer,
			'create_document',
			{
				title: 'Architecture RFC',
				parentDocumentId: rootDoc.id
			},
			token
		);

		expect(createResult.isError).toBeFalsy();
		const createdData = JSON.parse(getTextContent(createResult));
		const newDocId = createdData.id;
		expect(newDocId).toBeDefined();
		expect(createdData.parentDocumentId).toBe(rootDoc.id);

		// 2. Separate tool call: get_document on the newly created document
		// This simulates a fresh request where verifyToken() reads from SQLite
		const getResult = await invokeTool(mcpServer, 'get_document', { documentId: newDocId }, token);

		expect(getResult.isError).toBeFalsy();
		const getData = JSON.parse(getTextContent(getResult));
		expect(getData.id).toBe(newDocId);
		expect(getData.title).toBe('Architecture RFC');
		expect(getData.parentDocumentId).toBe(rootDoc.id);

		// 3. Separate tool call: create_record inside the newly created document
		const createBlockResult = await invokeTool(
			mcpServer,
			'create_record',
			{
				parentId: newDocId,
				blockType: 'heading_1'
			},
			token
		);
		expect(createBlockResult.isError).toBeFalsy();
	});

	it('supports move_document to reorganize hierarchy with permission checks', async () => {
		const { doc } = resolveWorkspaceContext();
		const folderA = createDocument(doc, { title: 'Folder A' });
		const folderB = createDocument(doc, { title: 'Folder B' });
		const childDoc = createDocument(doc, { title: 'Spec', parentDocumentId: folderA.id });

		// Token scoped to all three docs
		const { token } = createToken({
			clientLabel: 'Agent Bot',
			allowedDocumentIds: [folderA.id, folderB.id, childDoc.id],
			allowedCollectionIds: []
		});

		const mcpServer = createMcpServer();

		// Move childDoc from Folder A to Folder B
		const moveResult = await invokeTool(
			mcpServer,
			'move_document',
			{
				documentId: childDoc.id,
				parentDocumentId: folderB.id
			},
			token
		);

		expect(moveResult.isError).toBeFalsy();

		// Verify get_document reflects new parent
		const getResult = await invokeTool(
			mcpServer,
			'get_document',
			{ documentId: childDoc.id },
			token
		);
		const getData = JSON.parse(getTextContent(getResult));
		expect(getData.parentDocumentId).toBe(folderB.id);
	});

	it('blocks moving a document into an inaccessible parent', async () => {
		const { doc } = resolveWorkspaceContext();
		const allowedDoc = createDocument(doc, { title: 'Allowed' });
		const secretDoc = createDocument(doc, { title: 'Secret' });

		// Token only allowed on allowedDoc
		const { token } = createToken({
			clientLabel: 'Scoped Bot',
			allowedDocumentIds: [allowedDoc.id],
			allowedCollectionIds: []
		});

		const mcpServer = createMcpServer();

		// Attempt to move allowedDoc under secretDoc
		const moveResult = await invokeTool(
			mcpServer,
			'move_document',
			{
				documentId: allowedDoc.id,
				parentDocumentId: secretDoc.id
			},
			token
		);

		expect(moveResult.isError).toBe(true);
		expect(getTextContent(moveResult)).toContain('Permission denied');
	});

	it('creates and transcodes page_link blocks as [[Document Title]] references', async () => {
		const { doc } = resolveWorkspaceContext();
		const docA = createDocument(doc, { title: 'Target Document' });
		const docB = createDocument(doc, { title: 'Source Document' });

		const { token } = createToken({
			clientLabel: 'Linker Bot',
			allowedDocumentIds: [docA.id, docB.id],
			allowedCollectionIds: []
		});

		const mcpServer = createMcpServer();

		// Create a page_link block pointing to docA
		const createBlockResult = await invokeTool(
			mcpServer,
			'create_record',
			{
				parentId: docB.id,
				blockType: 'page_link'
			},
			token
		);
		expect(createBlockResult.isError).toBeFalsy();
		const blockId = JSON.parse(getTextContent(createBlockResult)).recordId;

		// Hold and write markdown with [[Target Document]]
		await invokeTool(mcpServer, 'hold_records', { recordIds: [blockId] }, token);
		const writeResult = await invokeTool(
			mcpServer,
			'write_record',
			{
				recordId: blockId,
				markdown: '[[Target Document]]'
			},
			token
		);
		expect(writeResult.isError).toBeFalsy();

		// Read document and assert markdown has [[Target Document]]
		const getResult = await invokeTool(mcpServer, 'get_document', { documentId: docB.id }, token);
		expect(getResult.isError).toBeFalsy();
		const docData = JSON.parse(getTextContent(getResult));
		const pageLinkRecord = docData.records.find(
			(r: { id: string; markdown: string }) => r.id === blockId
		);
		expect(pageLinkRecord).toBeDefined();
		expect(pageLinkRecord.markdown).toContain('[[Target Document]]');
	});

	it('create_record sets a page_link target via referencedRecordId, and write_record retargets it, over the MCP transport (issue #46)', async () => {
		const { doc } = resolveWorkspaceContext();
		const targetA = createDocument(doc, { title: 'Doc A' });
		const targetB = createDocument(doc, { title: 'Doc B' });
		const source = createDocument(doc, { title: 'Source Doc' });

		const { token } = createToken({
			clientLabel: 'Linker Bot',
			allowedDocumentIds: [targetA.id, targetB.id, source.id],
			allowedCollectionIds: []
		});
		const mcpServer = createMcpServer();

		const createResult = await invokeTool(
			mcpServer,
			'create_record',
			{ parentId: source.id, blockType: 'page_link', referencedRecordId: targetA.id },
			token
		);
		expect(createResult.isError).toBeFalsy();
		const blockId = JSON.parse(getTextContent(createResult)).recordId;

		let getResult = await invokeTool(mcpServer, 'get_document', { documentId: source.id }, token);
		let linked = JSON.parse(getTextContent(getResult)).records.find(
			(r: { id: string }) => r.id === blockId
		);
		expect(linked.referencedRecordId).toBe(targetA.id);
		expect(linked.markdown).toBe('[[Doc A]]');

		// Retarget via write_record's named field — no hold_records call first,
		// since a target-only write is metadata, not block content.
		const retargetResult = await invokeTool(
			mcpServer,
			'write_record',
			{ recordId: blockId, referencedRecordId: targetB.id },
			token
		);
		expect(retargetResult.isError).toBeFalsy();

		getResult = await invokeTool(mcpServer, 'get_document', { documentId: source.id }, token);
		linked = JSON.parse(getTextContent(getResult)).records.find(
			(r: { id: string }) => r.id === blockId
		);
		expect(linked.referencedRecordId).toBe(targetB.id);
		expect(linked.markdown).toBe('[[Doc B]]');
	});

	it('rejects a page_link target outside the token scope without leaking whether it exists', async () => {
		const { doc } = resolveWorkspaceContext();
		const secret = createDocument(doc, { title: 'Secret Doc' });
		const source = createDocument(doc, { title: 'Source Doc' });

		const { token } = createToken({
			clientLabel: 'Scoped Bot',
			allowedDocumentIds: [source.id],
			allowedCollectionIds: []
		});
		const mcpServer = createMcpServer();

		const createResult = await invokeTool(
			mcpServer,
			'create_record',
			{ parentId: source.id, blockType: 'page_link', referencedRecordId: secret.id },
			token
		);
		expect(createResult.isError).toBe(true);
		expect(getTextContent(createResult)).not.toContain('Secret Doc');
	});
});

describe('mcp server: authentication', () => {
	it('rejects a tool call with no bearer token', async () => {
		const mcpServer = createMcpServer();
		const result = await invokeTool(mcpServer, 'list_documents', {}, '');
		expect(result.isError).toBe(true);
		expect(getTextContent(result)).toContain('Permission denied');
	});

	it('rejects a tool call with an invalid or revoked token', async () => {
		const mcpServer = createMcpServer();
		const result = await invokeTool(mcpServer, 'list_documents', {}, 'not-a-real-token');
		expect(result.isError).toBe(true);
		expect(getTextContent(result)).toContain('Permission denied');
	});
});

describe('mcp server: full tool surface', () => {
	it('list_documents, delete_document, list_collections, and query_collection round-trip', async () => {
		const { doc } = resolveWorkspaceContext();
		const docA = createDocument(doc, { title: 'Doc A' });
		const collection = createCollection(doc, {
			title: 'Tasks',
			schema: [{ key: 'status', label: 'Status', type: 'select' }]
		});
		createRecord(
			doc,
			{ parentId: collection.id, properties: { status: { type: 'select', value: 'todo' } } },
			{
				kind: 'human',
				userId: 'brylie'
			}
		);

		const { token } = createToken({
			clientLabel: 'Full Surface Bot',
			allowedDocumentIds: [docA.id],
			allowedCollectionIds: [collection.id, 'nonexistent']
		});
		const mcpServer = createMcpServer();

		const listDocsResult = await invokeTool(mcpServer, 'list_documents', {}, token);
		expect(JSON.parse(getTextContent(listDocsResult))).toEqual([
			expect.objectContaining({ id: docA.id, title: 'Doc A' })
		]);

		const listCollectionsResult = await invokeTool(mcpServer, 'list_collections', {}, token);
		expect(JSON.parse(getTextContent(listCollectionsResult))).toEqual([
			expect.objectContaining({ id: collection.id, title: 'Tasks' })
		]);

		const queryResult = await invokeTool(
			mcpServer,
			'query_collection',
			{ collectionId: collection.id },
			token
		);
		const queried = JSON.parse(getTextContent(queryResult));
		expect(queried.title).toBe('Tasks');
		expect(queried.rows).toHaveLength(1);

		const queryMissingResult = await invokeTool(
			mcpServer,
			'query_collection',
			{ collectionId: 'nonexistent' },
			token
		);
		expect(queryMissingResult.isError).toBe(true);
		expect(getTextContent(queryMissingResult)).toContain('not found');

		const deleteResult = await invokeTool(
			mcpServer,
			'delete_document',
			{ documentId: docA.id },
			token
		);
		expect(deleteResult.isError).toBeFalsy();
		const getAfterDeleteResult = await invokeTool(
			mcpServer,
			'get_document',
			{ documentId: docA.id },
			token
		);
		expect(getAfterDeleteResult.isError).toBe(true);
	});

	it('list_collections and query_collection expose the resolved primary field (issue #96)', async () => {
		const { doc } = resolveWorkspaceContext();
		const autoCollection = createCollection(doc, {
			title: 'Auto',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		const explicitCollection = createCollection(doc, {
			title: 'Explicit',
			schema: [
				{ key: 'name', label: 'Name', type: 'text' },
				{ key: 'notes', label: 'Notes', type: 'text' }
			]
		});
		setPrimaryField(doc, explicitCollection.id, 'notes');

		const { token } = createToken({
			clientLabel: 'Primary Field Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: [autoCollection.id, explicitCollection.id]
		});
		const mcpServer = createMcpServer();

		const listResult = await invokeTool(mcpServer, 'list_collections', {}, token);
		const list = JSON.parse(getTextContent(listResult));
		expect(list).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: autoCollection.id, primaryFieldKey: 'name' }),
				expect.objectContaining({ id: explicitCollection.id, primaryFieldKey: 'notes' })
			])
		);

		const queryResult = await invokeTool(
			mcpServer,
			'query_collection',
			{ collectionId: explicitCollection.id },
			token
		);
		expect(JSON.parse(getTextContent(queryResult)).primaryFieldKey).toBe('notes');
	});

	it('search_workspace, hold_records, release_records, write_record, and delete_record round-trip', async () => {
		const { doc } = resolveWorkspaceContext();
		const docA = createDocument(doc, { title: 'Searchable Doc' });

		const { token } = createToken({
			clientLabel: 'Full Surface Bot 2',
			allowedDocumentIds: [docA.id],
			allowedCollectionIds: []
		});
		const mcpServer = createMcpServer();

		const createBlockResult = await invokeTool(
			mcpServer,
			'create_record',
			{ parentId: docA.id, blockType: 'paragraph' },
			token
		);
		const blockId = JSON.parse(getTextContent(createBlockResult)).recordId;

		const holdResult = await invokeTool(mcpServer, 'hold_records', { recordIds: [blockId] }, token);
		expect(JSON.parse(getTextContent(holdResult)).granted).toContain(blockId);

		const writeResult = await invokeTool(
			mcpServer,
			'write_record',
			{ recordId: blockId, markdown: 'Alpha findings' },
			token
		);
		expect(writeResult.isError).toBeFalsy();

		const searchResult = await invokeTool(mcpServer, 'search_workspace', { query: 'Alpha' }, token);
		const results = JSON.parse(getTextContent(searchResult));
		expect(results.some((r: { recordId: string }) => r.recordId === blockId)).toBe(true);

		const secondHold = await invokeTool(mcpServer, 'hold_records', { recordIds: [blockId] }, token);
		expect(JSON.parse(getTextContent(secondHold)).granted).toContain(blockId);
		const releaseResult = await invokeTool(
			mcpServer,
			'release_records',
			{ recordIds: [blockId] },
			token
		);
		expect(releaseResult.isError).toBeFalsy();

		const deleteRecordResult = await invokeTool(
			mcpServer,
			'delete_record',
			{ recordId: blockId },
			token
		);
		expect(deleteRecordResult.isError).toBeFalsy();
	});

	it('surfaces a HoldRequiredError as a non-throwing tool error', async () => {
		const { doc } = resolveWorkspaceContext();
		const docA = createDocument(doc, { title: 'Unheld Doc' });
		const { token } = createToken({
			clientLabel: 'No Hold Bot',
			allowedDocumentIds: [docA.id],
			allowedCollectionIds: []
		});
		const mcpServer = createMcpServer();

		const createBlockResult = await invokeTool(
			mcpServer,
			'create_record',
			{ parentId: docA.id, blockType: 'paragraph' },
			token
		);
		const blockId = JSON.parse(getTextContent(createBlockResult)).recordId;

		const writeResult = await invokeTool(
			mcpServer,
			'write_record',
			{ recordId: blockId, markdown: 'no hold acquired' },
			token
		);
		expect(writeResult.isError).toBe(true);
		expect(getTextContent(writeResult)).toMatch(/hold_records/);
	});

	it('surfaces an unexpected error generically', async () => {
		const { doc } = resolveWorkspaceContext();
		const docA = createDocument(doc, { title: 'Doc' });
		const { token } = createToken({
			clientLabel: 'Bad Write Bot',
			allowedDocumentIds: [docA.id],
			allowedCollectionIds: []
		});
		const mcpServer = createMcpServer();

		const createBlockResult = await invokeTool(
			mcpServer,
			'create_record',
			{ parentId: docA.id, blockType: 'paragraph' },
			token
		);
		const blockId = JSON.parse(getTextContent(createBlockResult)).recordId;

		// write_record with none of markdown/properties/referencedRecordId throws a plain Error.
		const writeResult = await invokeTool(mcpServer, 'write_record', { recordId: blockId }, token);
		expect(writeResult.isError).toBe(true);
		expect(getTextContent(writeResult)).toContain('markdown, properties, or referencedRecordId');
	});
});
