import { error } from '@sveltejs/kit';
import { getYDoc } from '$lib/server/ydoc';
import { getCollection } from '$lib/data/records';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	const doc = getYDoc();
	const collection = getCollection(doc, params.id);
	if (!collection) error(404, 'Collection not found');
	return { collectionId: collection.id, title: collection.title };
};
