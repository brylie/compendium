import { fail, redirect } from '@sveltejs/kit';
import { createCollection, createDocument } from '$lib/services';
import { CURRENT_USER } from '$lib/server/current-user';
import { listCatalogCollections, listCatalogDocuments } from '$lib/server/catalog';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const { workspaceId } = resolveWorkspaceContext();
	return {
		documents: listCatalogDocuments(workspaceId),
		collections: listCatalogCollections(workspaceId)
	};
};

export const actions: Actions = {
	createDocument: async ({ request }) => {
		const data = await request.formData();
		const title = String(data.get('title') ?? '').trim();
		const parentDocumentId = String(data.get('parentDocumentId') ?? '').trim() || undefined;
		if (!title) return fail(400, { error: 'Title is required' });

		const document = createDocument(CURRENT_USER, {
			title,
			parentDocumentId,
			createInitialBlock: true
		});
		redirect(303, `/doc/${document.id}`);
	},
	createCollection: async ({ request }) => {
		const data = await request.formData();
		const title = String(data.get('title') ?? '').trim();
		if (!title) return fail(400, { error: 'Title is required' });

		const collection = createCollection(CURRENT_USER, { title, schema: [] });
		redirect(303, `/table/${collection.id}`);
	}
};
