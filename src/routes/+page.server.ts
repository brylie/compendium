import { fail, redirect } from '@sveltejs/kit';
import { createCollection, createDocument, listCollections, listDocuments } from '$lib/services';
import type { Actions, PageServerLoad } from './$types';

// Routed through the service layer, not the bare catalog reads directly —
// see +layout.server.ts's identical comment for why (uncataloged content
// would otherwise silently vanish from these cards).
export const load: PageServerLoad = ({ locals }) => {
	return {
		documents: listDocuments(locals.requestContext.caller),
		collections: listCollections(locals.requestContext.caller)
	};
};

export const actions: Actions = {
	createDocument: async ({ request, locals }) => {
		const data = await request.formData();
		const title = String(data.get('title') ?? '').trim();
		const parentDocumentId = String(data.get('parentDocumentId') ?? '').trim() || undefined;
		if (!title) return fail(400, { error: 'Title is required' });

		const document = createDocument(locals.requestContext.caller, {
			title,
			parentDocumentId,
			createInitialBlock: true
		});
		redirect(303, `/doc/${document.id}`);
	},
	createCollection: async ({ request, locals }) => {
		const data = await request.formData();
		const title = String(data.get('title') ?? '').trim();
		if (!title) return fail(400, { error: 'Title is required' });

		const collection = createCollection(locals.requestContext.caller, { title, schema: [] });
		redirect(303, `/table/${collection.id}`);
	}
};
