import { fail, redirect } from '@sveltejs/kit';
import { getYDoc } from '$lib/server/ydoc';
import {
	createCollection,
	createDocument,
	createRecord,
	listCollections,
	listDocuments
} from '$lib/data/records';
import { logAudit } from '$lib/server/audit';
import type { Actions, PageServerLoad } from './$types';

const CURRENT_USER = { kind: 'human', userId: 'local' } as const;

export const load: PageServerLoad = () => {
	const doc = getYDoc();
	return {
		documents: listDocuments(doc),
		collections: listCollections(doc)
	};
};

export const actions: Actions = {
	createDocument: async ({ request }) => {
		const data = await request.formData();
		const title = String(data.get('title') ?? '').trim();
		const parentDocumentId = String(data.get('parentDocumentId') ?? '').trim() || undefined;
		if (!title) return fail(400, { error: 'Title is required' });

		const doc = getYDoc();
		const document = createDocument(doc, { title, parentDocumentId });
		createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, CURRENT_USER);
		logAudit({ actor: CURRENT_USER, action: 'create_document', targetRecordId: document.id });
		redirect(303, `/doc/${document.id}`);
	},
	createCollection: async ({ request }) => {
		const data = await request.formData();
		const title = String(data.get('title') ?? '').trim();
		if (!title) return fail(400, { error: 'Title is required' });

		const doc = getYDoc();
		const collection = createCollection(doc, { title, schema: [] });
		logAudit({ actor: CURRENT_USER, action: 'create_collection', targetRecordId: collection.id });
		redirect(303, `/table/${collection.id}`);
	}
};
