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
});
