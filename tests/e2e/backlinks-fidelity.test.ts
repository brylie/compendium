import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './harness';
import { human, getResultText, parseMcpText } from './mcp-parity-helpers';
import { createDocument } from '$lib/services/documents';
import { createRecord } from '$lib/services/records';
import { resolveRequestContext } from '$lib/server/request-context';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { createSpace } from '$lib/server/catalog';
import { queryAuditLog } from '$lib/server/audit';
import { getRecord, getRecordYText } from '$lib/data/record-ops';
import { plainText } from '$lib/data/richtext';
import { LOCAL_UI_ORIGIN, transactWithOrigin } from '$lib/mutation-origin';
import type { Backlink } from '$lib/data/links';

describe('Backlinks and formatted workspace tokens over MCP', () => {
	let harness: TestHarness;
	beforeEach(async () => {
		harness = await createTestHarness();
	});
	afterEach(async () => {
		await harness?.cleanup();
	});

	it.each(['Document', 'Space'] as const)(
		'lists only permitted backlinks using a %s grant and keeps counts stable after formatting',
		async (grantKind) => {
			const context = resolveRequestContext(human);
			const space = createSpace(context.workspaceId, 'Visible Space');
			const secretSpace = createSpace(context.workspaceId, 'Secret Space');
			const target = createDocument(context, { title: 'Target', spaceId: space.id });
			const source = createDocument(context, { title: 'Visible source', spaceId: space.id });
			const hidden = createDocument(context, { title: 'Secret source', spaceId: secretSpace.id });
			const hiddenLink = createRecord(context, {
				parentId: hidden.id,
				blockType: 'page_link',
				referencedRecordId: target.id
			});
			const { token } = harness.createToken({
				clientLabel: 'Backlink reader',
				allowedDocumentIds: grantKind === 'Document' ? [target.id, source.id] : [],
				allowedCollectionIds: [],
				allowedSpaceIds: grantKind === 'Space' ? [space.id] : []
			});
			const mcp = await harness.getMcpClient(token);
			expect((await mcp.listTools()).tools.map((tool) => tool.name)).toContain('list_backlinks');
			const pageId = parseMcpText<{ recordId: string }>(
				await mcp.callTool({
					name: 'create_record',
					arguments: { parentId: source.id, blockType: 'page_link', referencedRecordId: target.id }
				})
			).recordId;
			const blockId = parseMcpText<{ recordId: string }>(
				await mcp.callTool({
					name: 'create_record',
					arguments: { parentId: source.id, blockType: 'paragraph' }
				})
			).recordId;
			expect(
				(await mcp.callTool({ name: 'hold_records', arguments: { recordIds: [blockId] } })).isError
			).toBeFalsy();
			const markdown = '**@local** and _[[Target]]_ and [[Target]]';
			expect(
				(await mcp.callTool({ name: 'write_record', arguments: { recordId: blockId, markdown } }))
					.isError
			).toBeFalsy();
			const yjs = harness.getYjsClient({ room: `shard-${source.id}`, disableBc: true });
			await harness.waitForCondition(() => {
				const content = getRecord(yjs.doc, blockId)?.content;
				return content !== undefined && plainText(content) === 'local and Target and Target';
			});
			const freshMcp = await harness.getMcpClient(token);
			const document = parseMcpText<{ records: { id: string; markdown: string }[] }>(
				await freshMcp.callTool({ name: 'get_document', arguments: { documentId: source.id } })
			);
			expect(document.records.find((record) => record.id === blockId)?.markdown).toBe(markdown);
			const result = await freshMcp.callTool({
				name: 'list_backlinks',
				arguments: { documentId: target.id }
			});
			const backlinks = parseMcpText<Backlink[]>(result);
			expect(backlinks).toHaveLength(3);
			expect(backlinks.filter((link) => link.sourceRecordId === blockId)).toHaveLength(2);
			expect(backlinks).toContainEqual({
				sourceDocumentId: source.id,
				sourceDocumentTitle: source.title,
				sourceRecordId: pageId,
				context: 'Page link'
			});
			expect(getResultText(result)).not.toContain(hidden.id);
			expect(getResultText(result)).not.toContain(hiddenLink.id);
			expect(getResultText(result)).not.toContain(hidden.title);
			expect(
				queryAuditLog({ targetRecordId: target.id }).filter(
					(entry) => entry.action === 'list_backlinks'
				)
			).toEqual([
				expect.objectContaining({
					actor: { kind: 'human-via-client', userId: 'local', client: 'Backlink reader' },
					diff: { count: 3 }
				})
			]);

			// A real browser-side formatting edit splits the first wiki link into
			// multiple Y.Text runs without creating extra logical references.
			const text = getRecordYText(yjs.doc, blockId)!;
			transactWithOrigin(yjs.doc, LOCAL_UI_ORIGIN, () => text.format(11, 3, { bold: true }));
			const serverDoc = resolveWorkspaceContext({ shardId: source.id }).doc;
			await harness.waitForCondition(
				() =>
					getRecord(serverDoc, blockId)?.content?.runs.some(
						(run) => run.text === 'arg' && run.marks.bold === true
					) ?? false
			);
			expect(
				parseMcpText<Backlink[]>(
					await freshMcp.callTool({ name: 'list_backlinks', arguments: { documentId: target.id } })
				)
			).toHaveLength(3);

			const { token: targetOnly } = harness.createToken({
				clientLabel: 'Target only',
				allowedDocumentIds: [target.id],
				allowedCollectionIds: []
			});
			const restricted = await harness.getMcpClient(targetOnly);
			expect(
				parseMcpText<Backlink[]>(
					await restricted.callTool({
						name: 'list_backlinks',
						arguments: { documentId: target.id }
					})
				)
			).toEqual([]);
			const denied = await restricted.callTool({
				name: 'list_backlinks',
				arguments: { documentId: hidden.id }
			});
			expect(denied.isError).toBe(true);
			expect(getResultText(denied)).toContain('Permission denied');
			expect(getResultText(denied)).not.toContain(hidden.title);
			expect(
				queryAuditLog({ targetRecordId: hidden.id }).filter(
					(entry) => entry.action === 'list_backlinks_denied'
				)
			).toEqual([
				expect.objectContaining({
					actor: { kind: 'human-via-client', userId: 'local', client: 'Target only' }
				})
			]);
		}
	);

	it('exports live tokens without mutating their marks and re-imports code as literal text', async () => {
		const context = resolveRequestContext(human);
		const target = createDocument(context, { title: 'Target' });
		const source = createDocument(context, { title: 'Code source' });
		const { token } = harness.createToken({
			clientLabel: 'Code reader',
			allowedDocumentIds: [source.id, target.id],
			allowedCollectionIds: []
		});
		const mcp = await harness.getMcpClient(token);
		const blockId = parseMcpText<{ recordId: string }>(
			await mcp.callTool({
				name: 'create_record',
				arguments: { parentId: source.id, blockType: 'paragraph' }
			})
		).recordId;
		expect(
			(await mcp.callTool({ name: 'hold_records', arguments: { recordIds: [blockId] } })).isError
		).toBeFalsy();
		expect(
			(
				await mcp.callTool({
					name: 'write_record',
					arguments: { recordId: blockId, markdown: '**@local** _[[Target]]_' }
				})
			).isError
		).toBeFalsy();
		const yjs = harness.getYjsClient({ room: `shard-${source.id}`, disableBc: true });
		await harness.waitForCondition(
			() =>
				getRecord(yjs.doc, blockId)?.content?.runs.some(
					(run) => run.marks.link === `record:${target.id}`
				) ?? false
		);
		const text = getRecordYText(yjs.doc, blockId)!;
		transactWithOrigin(yjs.doc, LOCAL_UI_ORIGIN, () => {
			text.format(0, 5, { code: true });
			text.format(6, 6, { code: true });
		});
		const serverDoc = resolveWorkspaceContext({ shardId: source.id }).doc;
		await harness.waitForCondition(
			() =>
				getRecord(serverDoc, blockId)?.content?.runs.filter((run) => run.marks.code).length === 2
		);
		const freshMcp = await harness.getMcpClient(token);
		const result = parseMcpText<{ records: { id: string; markdown: string }[] }>(
			await freshMcp.callTool({ name: 'get_document', arguments: { documentId: source.id } })
		);
		expect(result.records.find((record) => record.id === blockId)?.markdown).toBe(
			'**`@local`** _`[[Target]]`_'
		);
		expect(getRecord(serverDoc, blockId)?.content?.runs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ marks: { mention: 'local', bold: true, code: true } }),
				expect.objectContaining({
					marks: { link: `record:${target.id}`, italic: true, code: true }
				})
			])
		);
		const literalMarkdown = '**`@local`** _`[[Target]]`_';
		expect(
			(await freshMcp.callTool({ name: 'hold_records', arguments: { recordIds: [blockId] } }))
				.isError
		).toBeFalsy();
		expect(
			(
				await freshMcp.callTool({
					name: 'write_record',
					arguments: { recordId: blockId, markdown: literalMarkdown }
				})
			).isError
		).toBeFalsy();
		await harness.waitForCondition(
			() =>
				getRecord(yjs.doc, blockId)?.content?.runs.some(
					(run) =>
						run.text === '[[Target]]' && run.marks.code === true && run.marks.link === undefined
				) ?? false
		);
		const reRead = parseMcpText<{ records: { id: string; markdown: string }[] }>(
			await freshMcp.callTool({ name: 'get_document', arguments: { documentId: source.id } })
		);
		expect(reRead.records.find((record) => record.id === blockId)?.markdown).toBe(literalMarkdown);
		expect(
			parseMcpText<Backlink[]>(
				await freshMcp.callTool({ name: 'list_backlinks', arguments: { documentId: target.id } })
			)
		).toEqual([]);
	});
});
