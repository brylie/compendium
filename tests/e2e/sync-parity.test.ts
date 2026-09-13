import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './harness';
import { createRecord, getRecordYText } from '$lib/data/record-ops';
import { plainText, yTextToRichText } from '$lib/data/richtext';
import { createDocument, human, parseMcpText } from './mcp-parity-helpers';

describe('Sync Parity (MCP <-> Yjs)', () => {
	let harness: TestHarness;

	beforeEach(async () => {
		harness = await createTestHarness();
	});

	afterEach(async () => {
		await harness?.cleanup();
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
				const data = parseMcpText<{ records: { id: string; markdown: string }[] }>(res);
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
});
