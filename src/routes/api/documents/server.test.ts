import { describe, expect, it } from 'vitest';
import { POST } from './+server';
import { resolveRequestContext } from '$lib/server/request-context';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { createSpace, listCatalogDocuments } from '$lib/server/catalog';

function jsonRequest(body: unknown): Parameters<typeof POST>[0] {
	return {
		request: new Request('http://localhost/api/documents', {
			method: 'POST',
			body: JSON.stringify(body)
		}),
		locals: { requestContext: resolveRequestContext() }
	} as unknown as Parameters<typeof POST>[0];
}

describe('routes/api/documents', () => {
	it('creates a document with the given title', async () => {
		const response = await POST(jsonRequest({ title: 'API Doc' }));
		const data = await response.json();
		expect(data.title).toBe('API Doc');
	});

	it('defaults to "Untitled" when no title is given', async () => {
		const response = await POST(jsonRequest({}));
		const data = await response.json();
		expect(data.title).toBe('Untitled');
	});

	it('nests under a parent when parentDocumentId is given', async () => {
		const parentRes = await POST(jsonRequest({ title: 'Parent' }));
		const parent = await parentRes.json();

		const childRes = await POST(jsonRequest({ title: 'Child', parentDocumentId: parent.id }));
		const child = await childRes.json();

		expect(child.parentDocumentId).toBe(parent.id);
	});

	it('creates a document in the given Space when spaceId is provided', async () => {
		// A non-default Space, and an assertion against the catalog itself —
		// asserting only `data.title` (or using the default Space, which every
		// other test in this file already lands in implicitly) would still
		// pass even if the endpoint silently ignored `spaceId` entirely.
		const { workspaceId } = resolveWorkspaceContext();
		const otherSpace = createSpace(workspaceId, 'Other Space');

		const response = await POST(jsonRequest({ title: 'Scoped Doc', spaceId: otherSpace.id }));
		const data = await response.json();
		expect(data.title).toBe('Scoped Doc');

		const inOtherSpace = listCatalogDocuments(workspaceId, otherSpace.id);
		expect(inOtherSpace.some((d) => d.id === data.id)).toBe(true);
	});

	it('returns a 400 error for an unknown spaceId instead of letting the FK violation escape', async () => {
		await expect(
			POST(jsonRequest({ title: 'Doomed Doc', spaceId: 'not-a-real-space' }))
		).rejects.toMatchObject({ status: 400 });
	});
});
