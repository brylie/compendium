import { getYDoc } from '$lib/server/ydoc';
import { getDocument } from '$lib/data/records';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	const doc = getYDoc();
	const document = getDocument(doc, params.id);
	return { documentId: params.id, title: document?.title ?? 'Untitled' };
};
