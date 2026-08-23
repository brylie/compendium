import { test, expect } from '@playwright/test';
import { createTestHarness, type TestHarness } from './harness';
import { createDocument, createRecord } from '$lib/services';
import { flush } from '$lib/server/ydoc';
import type { ActorId } from '$lib/data/types';

const human: ActorId = { kind: 'human', userId: 'brylie' };

test.describe('Tier B: DOM-visible MCP/Browser parity', () => {
	let harness: TestHarness;

	test.beforeEach(async () => {
		harness = await createTestHarness();
	});

	test.afterEach(async () => {
		await harness.cleanup();
	});

	test('Held-block placeholder appears on MCP hold and resolves atomically on MCP write', async ({
		page
	}) => {
		const docMeta = createDocument(human, {
			title: 'Live Browser Collaboration',
			createInitialBlock: false
		});
		const block = createRecord(human, { parentId: docMeta.id, blockType: 'paragraph' });
		flush();

		const { token } = harness.createToken({
			clientLabel: 'Claude Code',
			allowedDocumentIds: [docMeta.id],
			allowedCollectionIds: []
		});

		// 1. Open document in browser
		await page.goto(`${harness.httpUrl}/doc/${docMeta.id}`);
		await expect(page.locator('input[placeholder="Untitled document"]')).toHaveValue(
			'Live Browser Collaboration'
		);

		// 2. MCP client acquires hold on block
		const mcp = await harness.getMcpClient(token);
		const holdRes = await mcp.callTool({
			name: 'hold_records',
			arguments: { recordIds: [block.id] }
		});
		const res = holdRes as { content?: Array<{ text?: string }> };
		const rawText = res.content?.[0]?.text ?? '';
		expect(rawText).toContain(block.id);

		// 3. Browser UI should display held state (shimmer + agent client label)
		await expect(page.locator('.shimmer-bar')).toBeVisible({ timeout: 5000 });
		await expect(page.locator('text=Claude Code editing…')).toBeVisible({ timeout: 5000 });

		// 4. Agent writes to block
		await mcp.callTool({
			name: 'write_record',
			arguments: {
				recordId: block.id,
				markdown: 'Transformed by Claude Code agent in real time'
			}
		});

		// 5. Browser should atomically render updated markdown without manual reload
		await expect(page.locator('text=Transformed by Claude Code agent in real time')).toBeVisible({
			timeout: 5000
		});
		await expect(page.locator('.shimmer-bar')).not.toBeVisible();
	});

	test('Sidebar tree updates live on MCP create_document without manual page refresh', async ({
		page
	}) => {
		const rootDoc = createDocument(human, {
			title: 'Initial Root Doc',
			createInitialBlock: false
		});
		flush();

		const { token } = harness.createToken({
			clientLabel: 'Hierarchy Agent',
			allowedDocumentIds: [rootDoc.id],
			allowedCollectionIds: []
		});

		// 1. Open workspace home in browser
		await page.goto(`${harness.httpUrl}/doc/${rootDoc.id}`);
		await expect(page.locator('aside')).toContainText('Initial Root Doc');

		// 2. MCP creates a nested child document
		const mcp = await harness.getMcpClient(token);
		await mcp.callTool({
			name: 'create_document',
			arguments: {
				title: 'Realtime Child Doc',
				parentDocumentId: rootDoc.id
			}
		});

		// 3. Browser sidebar should reactively display the newly created document without page reload
		await expect(page.locator('aside')).toContainText('Realtime Child Doc', {
			timeout: 5000
		});
	});

	test('Document created via the browser UI is visible to MCP, and an MCP edit appears back in the browser live', async ({
		page
	}) => {
		// 1. Human creates a document through the real UI form, not the service layer directly
		await page.goto(harness.httpUrl);
		const createForm = page.locator('form:has(input[placeholder="New document title…"])');
		await createForm.locator('input[name="title"]').fill('Human-Created Doc');
		await createForm.locator('button[type="submit"]').click();
		await page.waitForURL(/\/doc\//);
		const docId = new URL(page.url()).pathname.split('/doc/')[1];
		expect(docId).toBeTruthy();

		// 2. A client is granted access to the document a human just created (mirrors the
		// settings/tokens "Allowed Documents" checkbox flow), then queries it via MCP
		const { token } = harness.createToken({
			clientLabel: 'Claude Code',
			allowedDocumentIds: [docId],
			allowedCollectionIds: []
		});
		const mcp = await harness.getMcpClient(token);

		const listRes = (await mcp.callTool({ name: 'list_documents', arguments: {} })) as {
			content?: Array<{ text?: string }>;
		};
		expect(listRes.content?.[0]?.text ?? '').toContain('Human-Created Doc');

		// 3. Agent adds a block to the human-created document
		const createRes = (await mcp.callTool({
			name: 'create_record',
			arguments: { parentId: docId, blockType: 'paragraph' }
		})) as { content?: Array<{ text?: string }> };
		const blockId = JSON.parse(createRes.content?.[0]?.text ?? '{}').recordId as string;
		expect(blockId).toBeTruthy();

		await mcp.callTool({ name: 'hold_records', arguments: { recordIds: [blockId] } });
		await mcp.callTool({
			name: 'write_record',
			arguments: { recordId: blockId, markdown: 'Agent wrote this after a human created the page' }
		});

		// 4. The still-open browser tab should show the agent's edit without a reload
		await expect(page.locator('text=Agent wrote this after a human created the page')).toBeVisible({
			timeout: 5000
		});
	});

	test('Document created via MCP appears live in the sidebar; a human edit typed in the browser is visible via MCP', async ({
		page
	}) => {
		// 1. Human has the workspace open before the agent does anything
		await page.goto(harness.httpUrl);

		// 2. Agent creates a top-level document
		const { token } = harness.createToken({
			clientLabel: 'Claude Code',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});
		const mcp = await harness.getMcpClient(token);
		const createRes = (await mcp.callTool({
			name: 'create_document',
			arguments: { title: 'Agent-Created Page' }
		})) as { content?: Array<{ text?: string }> };
		const docId = JSON.parse(createRes.content?.[0]?.text ?? '{}').id as string;
		expect(docId).toBeTruthy();

		// 3. Sidebar reflects the new document without a page reload
		await expect(page.locator('aside')).toContainText('Agent-Created Page', { timeout: 5000 });

		// 4. Human clicks into the agent-created page and types directly in the editor
		await page.locator('aside').getByText('Agent-Created Page').click();
		await page.waitForURL(new RegExp(`/doc/${docId}`));
		await page.getByRole('button', { name: /Type '\/' for commands/ }).click();
		await page.keyboard.type('Human typed this after the agent created the page');

		// 5. The agent's next read via MCP reflects the human's live keystrokes
		await expect(async () => {
			const getRes = (await mcp.callTool({
				name: 'get_document',
				arguments: { documentId: docId }
			})) as { content?: Array<{ text?: string }> };
			expect(getRes.content?.[0]?.text ?? '').toContain(
				'Human typed this after the agent created the page'
			);
		}).toPass({ timeout: 5000 });
	});
	test("An agent batch-writes across two documents in one hold, and client-side sidebar navigation between them shows each document's own content", async ({
		page
	}) => {
		// 1. Two documents already exist, each with one empty block
		const docA = createDocument(human, {
			title: 'Event Planning: Venue',
			createInitialBlock: false
		});
		const blockA = createRecord(human, { parentId: docA.id, blockType: 'paragraph' });
		const docB = createDocument(human, {
			title: 'Event Planning: Catering',
			createInitialBlock: false
		});
		const blockB = createRecord(human, { parentId: docB.id, blockType: 'paragraph' });
		flush();

		const { token } = harness.createToken({
			clientLabel: 'Claude Code',
			allowedDocumentIds: [docA.id, docB.id],
			allowedCollectionIds: []
		});
		const mcp = await harness.getMcpClient(token);

		// 2. Agent holds records from BOTH documents in a single batch call, then writes each
		const holdRes = (await mcp.callTool({
			name: 'hold_records',
			arguments: { recordIds: [blockA.id, blockB.id] }
		})) as { content?: Array<{ text?: string }> };
		const holdResult = JSON.parse(holdRes.content?.[0]?.text ?? '{}') as { granted?: string[] };
		expect(holdResult.granted).toEqual(expect.arrayContaining([blockA.id, blockB.id]));

		await mcp.callTool({
			name: 'write_record',
			arguments: { recordId: blockA.id, markdown: 'Venue confirmed: The Old Foundry.' }
		});
		await mcp.callTool({
			name: 'write_record',
			arguments: { recordId: blockB.id, markdown: 'Catering confirmed: Thistle and Thyme.' }
		});

		// 3. A human opens Doc A in the browser, then navigates to Doc B purely client-side
		// (sidebar click, not a full page load) -- each document's editor must show its own
		// content, not the previously-open document's stale blocks.
		await page.goto(`${harness.httpUrl}/doc/${docA.id}`);
		await expect(page.locator('text=Venue confirmed: The Old Foundry.')).toBeVisible({
			timeout: 5000
		});

		await page.locator('aside').getByText('Event Planning: Catering').click();
		await page.waitForURL(new RegExp(`/doc/${docB.id}`));
		await expect(page.locator('text=Catering confirmed: Thistle and Thyme.')).toBeVisible({
			timeout: 5000
		});
		await expect(page.locator('text=Venue confirmed: The Old Foundry.')).not.toBeVisible();

		// 4. And back again, the other direction
		await page.locator('aside').getByText('Event Planning: Venue').click();
		await page.waitForURL(new RegExp(`/doc/${docA.id}`));
		await expect(page.locator('text=Venue confirmed: The Old Foundry.')).toBeVisible({
			timeout: 5000
		});
		await expect(page.locator('text=Catering confirmed: Thistle and Thyme.')).not.toBeVisible();
	});
});
