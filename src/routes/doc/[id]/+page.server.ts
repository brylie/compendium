import { error } from '@sveltejs/kit';
import { getYDoc } from '$lib/server/ydoc';
import { getDocument } from '$lib/data/records';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	const doc = getYDoc();
	const document = getDocument(doc, params.id);
	if (!document) error(404, 'Document not found');
	return { documentId: document.id, title: document.title };
};
