import { getYDoc } from '$lib/server/ydoc';
import { listCollections, listDocuments } from '$lib/data/records';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = () => {
	const doc = getYDoc();
	return {
		documents: listDocuments(doc),
		collections: listCollections(doc)
	};
};
