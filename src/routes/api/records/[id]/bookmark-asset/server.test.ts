import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchImageAssetMock = vi.fn();
vi.mock('$lib/server/link-preview', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/link-preview')>(
		'$lib/server/link-preview'
	);
	return {
		...actual,
		fetchImageAsset: (...args: unknown[]) => fetchImageAssetMock(...args)
	};
});

// Imported after the mock so this route's own import of fetchImageAsset
// resolves to the mocked module, while LinkPreviewError (used for the
// error(502, ...) branch) stays the real class via importActual above.
const { GET } = await import('./+server');
const { resolveRequestContext } = await import('$lib/server/request-context');
const { createDocument } = await import('$lib/services/documents');
const { resolveParentWorkspaceContext } = await import('$lib/services/permissions');
const { createRecord: crdtCreateRecord, setRecordBookmarkMetadata } =
	await import('$lib/data/record-ops');
const { TEST_ORIGIN, transactWithOrigin } = await import('$lib/mutation-origin');
const { CURRENT_USER } = await import('$lib/server/current-user');

function getRequest(recordId: string, query: Record<string, string>): Parameters<typeof GET>[0] {
	const url = new URL(`http://localhost/api/records/${recordId}/bookmark-asset`);
	for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
	return {
		params: { id: recordId },
		url,
		locals: { requestContext: resolveRequestContext() }
	} as unknown as Parameters<typeof GET>[0];
}

// Bypasses the service layer entirely — the same "direct UI mutation"
// BookmarkBlock.svelte performs client-side (issue #155), which never
// reserves a catalog locator the way an MCP-created record does.
function createUiBookmark(
	documentId: string,
	url: string,
	faviconUrl?: string,
	thumbnailUrl?: string
): string {
	const { doc } = resolveParentWorkspaceContext(documentId);
	const record = transactWithOrigin(doc, TEST_ORIGIN, () =>
		crdtCreateRecord(doc, { parentId: documentId, blockType: 'bookmark', url }, CURRENT_USER)
	);
	transactWithOrigin(doc, TEST_ORIGIN, () =>
		setRecordBookmarkMetadata(
			doc,
			record.id,
			{ status: 'ready', faviconUrl, thumbnailUrl },
			CURRENT_USER
		)
	);
	return record.id;
}

describe('routes/api/records/[id]/bookmark-asset', () => {
	beforeEach(() => {
		fetchImageAssetMock.mockReset();
	});

	it("proxies the bookmark's scraped favicon, never exposing the raw external url to the client", async () => {
		fetchImageAssetMock.mockResolvedValueOnce({
			contentType: 'image/png',
			body: Buffer.from('fake-bytes')
		});
		const document = createDocument(CURRENT_USER, { title: 'Notes' });
		const recordId = createUiBookmark(
			document.id,
			'https://example.com/',
			'https://example.com/favicon.png'
		);

		const response = await GET(getRequest(recordId, { kind: 'favicon', documentId: document.id }));

		expect(fetchImageAssetMock).toHaveBeenCalledWith('https://example.com/favicon.png');
		expect(response.headers.get('content-type')).toBe('image/png');
		expect(await response.text()).toBe('fake-bytes');
	});

	it('proxies the thumbnail when kind=thumbnail', async () => {
		fetchImageAssetMock.mockResolvedValueOnce({
			contentType: 'image/jpeg',
			body: Buffer.from('thumb-bytes')
		});
		const document = createDocument(CURRENT_USER, { title: 'Notes' });
		const recordId = createUiBookmark(
			document.id,
			'https://example.com/',
			undefined,
			'https://example.com/thumb.jpg'
		);

		const response = await GET(
			getRequest(recordId, { kind: 'thumbnail', documentId: document.id })
		);

		expect(fetchImageAssetMock).toHaveBeenCalledWith('https://example.com/thumb.jpg');
		expect(response.headers.get('content-type')).toBe('image/jpeg');
	});

	it('rejects an invalid kind with a 400, never reaching fetchImageAsset', async () => {
		const document = createDocument(CURRENT_USER, { title: 'Notes' });
		const recordId = createUiBookmark(
			document.id,
			'https://example.com/',
			'https://example.com/f.png'
		);

		await expect(
			GET(getRequest(recordId, { kind: 'bogus', documentId: document.id }))
		).rejects.toMatchObject({ status: 400 });
		expect(fetchImageAssetMock).not.toHaveBeenCalled();
	});

	it('returns a 404 for a bookmark with no favicon to proxy', async () => {
		const document = createDocument(CURRENT_USER, { title: 'Notes' });
		const recordId = createUiBookmark(document.id, 'https://example.com/');

		await expect(
			GET(getRequest(recordId, { kind: 'favicon', documentId: document.id }))
		).rejects.toMatchObject({ status: 404 });
		expect(fetchImageAssetMock).not.toHaveBeenCalled();
	});

	it('returns a 404 for a non-bookmark record', async () => {
		const document = createDocument(CURRENT_USER, { title: 'Notes' });
		const { doc } = resolveParentWorkspaceContext(document.id);
		const paragraph = transactWithOrigin(doc, TEST_ORIGIN, () =>
			crdtCreateRecord(doc, { parentId: document.id, blockType: 'paragraph' }, CURRENT_USER)
		);

		await expect(
			GET(getRequest(paragraph.id, { kind: 'favicon', documentId: document.id }))
		).rejects.toMatchObject({ status: 404 });
		expect(fetchImageAssetMock).not.toHaveBeenCalled();
	});

	it('maps a fetch failure to a 502 rather than a bare 500', async () => {
		const { LinkPreviewError } = await vi.importActual<typeof import('$lib/server/link-preview')>(
			'$lib/server/link-preview'
		);
		fetchImageAssetMock.mockRejectedValueOnce(new LinkPreviewError('refused'));
		const document = createDocument(CURRENT_USER, { title: 'Notes' });
		const recordId = createUiBookmark(
			document.id,
			'https://example.com/',
			'https://example.com/favicon.png'
		);

		await expect(
			GET(getRequest(recordId, { kind: 'favicon', documentId: document.id }))
		).rejects.toMatchObject({ status: 502 });
	});
});
