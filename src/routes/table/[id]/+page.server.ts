import { getYDoc } from '$lib/server/ydoc';
import { getCollection } from '$lib/data/records';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	const doc = getYDoc();
	const collection = getCollection(doc, params.id);
	return { collectionId: params.id, title: collection?.title ?? 'Untitled Collection' };
};
