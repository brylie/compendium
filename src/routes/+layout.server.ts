import { listCollections, listDocuments } from '$lib/services';
import { CURRENT_USER } from '$lib/server/current-user';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = () => {
	return {
		documents: listDocuments(CURRENT_USER),
		collections: listCollections(CURRENT_USER)
	};
};
