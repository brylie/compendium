import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchLinkPreviewMetadataMock = vi.fn();
vi.mock('$lib/server/link-preview', () => ({
	fetchLinkPreviewMetadata: (...args: unknown[]) => fetchLinkPreviewMetadataMock(...args)
}));

// Imported after the mock so services/records.ts's own
// `import { fetchLinkPreviewMetadata } from '$lib/server/link-preview'`
// resolves to the mocked module — mirrors link-preview.test.ts's own
// mock-then-dynamic-import pattern.
const { createDocument } = await import('$lib/services/documents');
const { createRecord, refreshBookmarkMetadata, writeRecord, getRecord, PermissionDeniedError } =
	await import('$lib/services');
const { createToken } = await import('$lib/mcp/tokens');
const { queryAuditLog } = await import('$lib/server/audit');
const { createRecord: crdtCreateRecord } = await import('$lib/data/record-ops');
const { resolveParentWorkspaceContext } = await import('$lib/services/permissions');
const { TEST_ORIGIN, transactWithOrigin } = await import('$lib/mutation-origin');
import type { ActorId } from '$lib/data/types';

const human: ActorId = { kind: 'human', userId: 'brylie' };

describe('bookmark block service layer (issue #155)', () => {
	beforeEach(() => {
		// mockReset (not mockClear): also drops any unconsumed
		// mockReturnValueOnce/mockResolvedValueOnce queued by a previous test,
		// so an assertion like "not.toHaveBeenCalled()" can't pass or fail
		// depending on what ran before it.
		fetchLinkPreviewMetadataMock.mockReset();
	});

	it('createRecord rejects a url on a non-bookmark block type', () => {
		const document = createDocument(human, { title: 'Notes' });
		expect(() =>
			createRecord(human, {
				parentId: document.id,
				blockType: 'paragraph',
				url: 'https://example.com/'
			})
		).toThrow('url is only valid on a bookmark block.');
	});

	it('createRecord rejects a non-http(s) or malformed url', () => {
		const document = createDocument(human, { title: 'Notes' });
		expect(() =>
			createRecord(human, { parentId: document.id, blockType: 'bookmark', url: 'not a url' })
		).toThrow('url must be an absolute http(s) URL.');
		expect(() =>
			createRecord(human, {
				parentId: document.id,
				blockType: 'bookmark',
				url: 'ftp://example.com/file'
			})
		).toThrow('url must be an absolute http(s) URL.');
	});

	it('createRecord with a valid bookmark url sets an initial pending status, without fetching anything itself', () => {
		const document = createDocument(human, { title: 'Notes' });
		const record = createRecord(human, {
			parentId: document.id,
			blockType: 'bookmark',
			url: 'https://example.com/article'
		});
		expect(record.url).toBe('https://example.com/article');
		expect(record.bookmarkMetadata).toEqual({ status: 'pending' });
		// createRecord itself never calls the fetch — that's the MCP tool
		// handler's job (server.ts), so an agent gets one round trip; the
		// synchronous service function stays synchronous.
		expect(fetchLinkPreviewMetadataMock).not.toHaveBeenCalled();
	});

	it('createRecord leaves a bookmark with no url unconfigured', () => {
		const document = createDocument(human, { title: 'Notes' });
		const record = createRecord(human, { parentId: document.id, blockType: 'bookmark' });
		expect(record.url).toBeUndefined();
		expect(record.bookmarkMetadata).toBeUndefined();
	});

	it('refreshBookmarkMetadata fetches and writes a ready preview, and logs it as write_record', () => {
		fetchLinkPreviewMetadataMock.mockReturnValueOnce(
			Promise.resolve({ title: 'Example Domain', description: 'An example.' })
		);
		const document = createDocument(human, { title: 'Notes' });
		const record = createRecord(human, {
			parentId: document.id,
			blockType: 'bookmark',
			url: 'https://example.com/'
		});

		return refreshBookmarkMetadata(human, record.id).then((updated) => {
			expect(updated.bookmarkMetadata?.status).toBe('ready');
			expect(updated.bookmarkMetadata?.title).toBe('Example Domain');
			expect(updated.bookmarkMetadata?.description).toBe('An example.');
			expect(updated.bookmarkMetadata?.fetchedAt).toEqual(expect.any(Number));
			expect(getRecord(human, record.id)?.bookmarkMetadata?.status).toBe('ready');

			const audits = queryAuditLog();
			expect(
				audits.some((a) => a.action === 'write_record' && a.targetRecordId === record.id)
			).toBe(true);
		});
	});

	it('refreshBookmarkMetadata degrades to an error status (never throws) when the fetch fails, leaving the url intact', () => {
		fetchLinkPreviewMetadataMock.mockReturnValueOnce(Promise.reject(new Error('boom')));
		const document = createDocument(human, { title: 'Notes' });
		const record = createRecord(human, {
			parentId: document.id,
			blockType: 'bookmark',
			url: 'https://example.com/broken'
		});

		return refreshBookmarkMetadata(human, record.id).then((updated) => {
			expect(updated.bookmarkMetadata?.status).toBe('error');
			expect(updated.url).toBe('https://example.com/broken');
		});
	});

	it('refreshBookmarkMetadata throws for a non-bookmark block', () => {
		const document = createDocument(human, { title: 'Notes' });
		const record = createRecord(human, { parentId: document.id, blockType: 'paragraph' });
		return expect(refreshBookmarkMetadata(human, record.id)).rejects.toThrow(
			'refreshBookmarkMetadata can only be called on a bookmark block.'
		);
	});

	it('refreshBookmarkMetadata throws for a bookmark block with no url yet', () => {
		const document = createDocument(human, { title: 'Notes' });
		const record = createRecord(human, { parentId: document.id, blockType: 'bookmark' });
		return expect(refreshBookmarkMetadata(human, record.id)).rejects.toThrow(
			'This bookmark block has no url set yet.'
		);
	});

	it('writeRecord rejects a markdown write against a bookmark block', () => {
		const document = createDocument(human, { title: 'Notes' });
		const record = createRecord(human, {
			parentId: document.id,
			blockType: 'bookmark',
			url: 'https://example.com/'
		});
		expect(() => writeRecord(human, record.id, { markdown: 'Some text' })).toThrow(
			'markdown cannot be written to a bookmark block'
		);
	});

	it('refreshBookmarkMetadata resolves a direct-UI-created bookmark (no catalog locator of its own) via the documentId hint', async () => {
		fetchLinkPreviewMetadataMock.mockReturnValueOnce(
			Promise.resolve({ title: 'Direct UI Bookmark' })
		);
		const document = createDocument(human, { title: 'Notes' });
		// Bypasses the service layer entirely — the same "direct UI mutation"
		// BookmarkBlock.svelte performs client-side (setBlockType + setRecordUrl
		// against the browser's own Y.Doc), which never reserves a locator the
		// way this module's own createRecord does (issue #155).
		const { doc } = resolveParentWorkspaceContext(document.id);
		const record = transactWithOrigin(doc, TEST_ORIGIN, () =>
			crdtCreateRecord(
				doc,
				{ parentId: document.id, blockType: 'bookmark', url: 'https://example.com/' },
				human
			)
		);

		// Without the hint, the record has no locator to resolve by — the bare
		// recordId lookup falls back to the wrong (default) shard once
		// Documents are individually sharded (#120), so the record can't be
		// found there.
		await expect(refreshBookmarkMetadata(human, record.id)).rejects.toThrow(PermissionDeniedError);

		// With the documentId hint (resolving via the owning Document's own,
		// always-locator-tracked id instead), the same call succeeds.
		const updated = await refreshBookmarkMetadata(human, record.id, document.id);
		expect(updated.bookmarkMetadata).toMatchObject({
			status: 'ready',
			title: 'Direct UI Bookmark'
		});
	});

	it('refreshBookmarkMetadata enforces the same permission boundary as write_record', () => {
		const docSecret = createDocument(human, { title: 'Secret Doc' });
		const record = createRecord(human, {
			parentId: docSecret.id,
			blockType: 'bookmark',
			url: 'https://example.com/'
		});
		const { record: tokenRecord } = createToken({
			clientLabel: 'Scoped Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});

		return expect(refreshBookmarkMetadata(tokenRecord, record.id)).rejects.toThrow(
			PermissionDeniedError
		);
	});
});
