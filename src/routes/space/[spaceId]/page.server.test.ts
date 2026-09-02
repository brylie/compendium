import { describe, expect, it } from 'vitest';
import { load, actions } from './+page.server';
import { createDocument } from '$lib/services';
import { CURRENT_USER } from '$lib/server/current-user';
import { resolveRequestContext } from '$lib/server/request-context';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';

function spaceId(): string {
	return resolveWorkspaceContext().defaultSpaceId;
}

function formEvent(fields: Record<string, string>): Parameters<typeof actions.createDocument>[0] {
	const formData = new FormData();
	for (const [key, value] of Object.entries(fields)) formData.set(key, value);
	return {
		params: { spaceId: spaceId() },
		request: { formData: async () => formData },
		locals: { requestContext: resolveRequestContext() }
	} as unknown as Parameters<typeof actions.createDocument>[0];
}

describe('routes/+page.server: workspace home', () => {
	it('load() lists documents and collections for the current user', () => {
		createDocument(CURRENT_USER, { title: 'Existing Doc' });
		const result = load({
			params: { spaceId: spaceId() },
			locals: { requestContext: resolveRequestContext() }
		} as unknown as Parameters<typeof load>[0]) as unknown as {
			documents: { title: string }[];
			collections: unknown[];
		};
		expect(result.documents.some((d) => d.title === 'Existing Doc')).toBe(true);
		expect(Array.isArray(result.collections)).toBe(true);
	});

	it('createDocument action fails on a blank title', async () => {
		const result = await actions.createDocument(formEvent({ title: '   ' }));
		expect(result).toEqual({ status: 400, data: { error: 'Title is required' } });
	});

	it('createDocument action creates a top-level document and redirects to it', async () => {
		await expect(actions.createDocument(formEvent({ title: 'New Doc' }))).rejects.toMatchObject({
			status: 303,
			location: expect.stringMatching(/^\/space\/.+\/doc\//)
		});
	});

	it('createDocument action nests under a parent when parentDocumentId is given', async () => {
		const parent = createDocument(CURRENT_USER, { title: 'Parent' });
		await expect(
			actions.createDocument(formEvent({ title: 'Child', parentDocumentId: parent.id }))
		).rejects.toMatchObject({
			status: 303,
			location: expect.stringMatching(/^\/space\/.+\/doc\//)
		});
	});

	it('createCollection action fails on a blank title', async () => {
		const result = await actions.createCollection(formEvent({ title: '' }));
		expect(result).toEqual({ status: 400, data: { error: 'Title is required' } });
	});

	it('createCollection action creates a collection and redirects to it', async () => {
		await expect(actions.createCollection(formEvent({ title: 'New Table' }))).rejects.toMatchObject(
			{ status: 303, location: expect.stringMatching(/^\/space\/.+\/table\//) }
		);
	});
});
