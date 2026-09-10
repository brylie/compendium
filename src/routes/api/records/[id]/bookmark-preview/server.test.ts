import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchLinkPreviewMetadataMock = vi.fn();
vi.mock('$lib/server/link-preview', () => ({
	fetchLinkPreviewMetadata: (...args: unknown[]) => fetchLinkPreviewMetadataMock(...args)
}));

// Imported after the mock so services/records.ts's own import of
// fetchLinkPreviewMetadata resolves to the mocked module.
const { POST } = await import('./+server');
const { resolveRequestContext } = await import('$lib/server/request-context');
const { createDocument } = await import('$lib/services/documents');
const { resolveParentWorkspaceContext } = await import('$lib/services/permissions');
const { createRecord: crdtCreateRecord } = await import('$lib/data/record-ops');
const { TEST_ORIGIN, transactWithOrigin } = await import('$lib/mutation-origin');
const { CURRENT_USER } = await import('$lib/server/current-user');

function jsonRequest(recordId: string, body: unknown): Parameters<typeof POST>[0] {
	return {
		params: { id: recordId },
		request: new Request(`http://localhost/api/records/${recordId}/bookmark-preview`, {
			method: 'POST',
			body: JSON.stringify(body)
		}),
		locals: { requestContext: resolveRequestContext() }
	} as unknown as Parameters<typeof POST>[0];
}

function createUiBookmark(documentId: string, url: string): string {
	// Bypasses the service layer entirely — the same "direct UI mutation"
	// BookmarkBlock.svelte performs client-side, which never reserves a
	// catalog locator the way an MCP-created record does (issue #155).
	const { doc } = resolveParentWorkspaceContext(documentId);
	const record = transactWithOrigin(doc, TEST_ORIGIN, () =>
		crdtCreateRecord(doc, { parentId: documentId, blockType: 'bookmark', url }, CURRENT_USER)
	);
	return record.id;
}

describe('routes/api/records/[id]/bookmark-preview', () => {
	beforeEach(() => {
		fetchLinkPreviewMetadataMock.mockReset();
	});

	it('fetches and returns the preview metadata for a direct-UI-created bookmark', async () => {
		fetchLinkPreviewMetadataMock.mockResolvedValueOnce({ title: 'Example Domain' });
		const document = createDocument(CURRENT_USER, { title: 'Notes' });
		const recordId = createUiBookmark(document.id, 'https://example.com/');

		const response = await POST(jsonRequest(recordId, { documentId: document.id }));
		const data = await response.json();

		expect(data.bookmarkMetadata).toMatchObject({ status: 'ready', title: 'Example Domain' });
	});

	it('returns a 400 error for a missing documentId instead of silently falling back to bare-id resolution', async () => {
		const document = createDocument(CURRENT_USER, { title: 'Notes' });
		const recordId = createUiBookmark(document.id, 'https://example.com/');

		await expect(POST(jsonRequest(recordId, {}))).rejects.toMatchObject({ status: 400 });
		expect(fetchLinkPreviewMetadataMock).not.toHaveBeenCalled();
	});

	it('returns a 400 error for a malformed (non-JSON) request body instead of a 500', async () => {
		const document = createDocument(CURRENT_USER, { title: 'Notes' });
		const recordId = createUiBookmark(document.id, 'https://example.com/');
		const badRequest = {
			params: { id: recordId },
			request: new Request(`http://localhost/api/records/${recordId}/bookmark-preview`, {
				method: 'POST',
				body: 'not json'
			}),
			locals: { requestContext: resolveRequestContext() }
		} as unknown as Parameters<typeof POST>[0];

		await expect(POST(badRequest)).rejects.toMatchObject({ status: 400 });
	});

	it('returns a 400 error for a JSON `null` body rather than throwing a TypeError', async () => {
		const document = createDocument(CURRENT_USER, { title: 'Notes' });
		const recordId = createUiBookmark(document.id, 'https://example.com/');
		const nullBodyRequest = {
			params: { id: recordId },
			request: new Request(`http://localhost/api/records/${recordId}/bookmark-preview`, {
				method: 'POST',
				body: 'null'
			}),
			locals: { requestContext: resolveRequestContext() }
		} as unknown as Parameters<typeof POST>[0];

		await expect(POST(nullBodyRequest)).rejects.toMatchObject({ status: 400 });
	});
});
