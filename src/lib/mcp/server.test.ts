import { describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './server';
import { createToken } from './tokens';
import { getYDoc } from '$lib/server/ydoc';
import { createDocument } from '$lib/data/records';

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
		const doc = getYDoc();
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
		const doc = getYDoc();
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
		const doc = getYDoc();
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
		const doc = getYDoc();
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
});
