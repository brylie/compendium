import { fail, redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import {
	createCollection,
	createDocument,
	listCollections,
	listDocuments,
	SpaceMismatchError
} from '$lib/services';
import type { Actions, PageServerLoad } from './$types';

// Routed through the service layer, not the bare catalog reads directly —
// see +layout.server.ts's identical comment for why (uncataloged content
// would otherwise silently vanish from these cards). params.spaceId is
// already validated by the parent +layout.server.ts.
export const load: PageServerLoad = ({ params, locals }) => {
	return {
		documents: listDocuments(locals.requestContext.caller, params.spaceId),
		collections: listCollections(locals.requestContext.caller, params.spaceId)
	};
};

export const actions: Actions = {
	createDocument: async ({ params, request, locals }) => {
		const data = await request.formData();
		const title = String(data.get('title') ?? '').trim();
		const parentDocumentId = String(data.get('parentDocumentId') ?? '').trim() || undefined;
		if (!title) return fail(400, { error: 'Title is required' });

		let document;
		try {
			document = createDocument(locals.requestContext.caller, {
				title,
				parentDocumentId,
				createInitialBlock: true,
				spaceId: params.spaceId
			});
		} catch (err) {
			if (err instanceof SpaceMismatchError) {
				return fail(400, { error: err.message });
			}
			throw err;
		}
		redirect(
			303,
			resolve('/space/[spaceId]/doc/[id]', { spaceId: params.spaceId, id: document.id })
		);
	},
	createCollection: async ({ params, request, locals }) => {
		const data = await request.formData();
		const title = String(data.get('title') ?? '').trim();
		if (!title) return fail(400, { error: 'Title is required' });

		const collection = createCollection(locals.requestContext.caller, {
			title,
			schema: [],
			spaceId: params.spaceId
		});
		redirect(
			303,
			resolve('/space/[spaceId]/table/[id]', { spaceId: params.spaceId, id: collection.id })
		);
	}
};
