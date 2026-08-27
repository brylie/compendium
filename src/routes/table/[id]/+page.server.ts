import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { getCollection } from '$lib/data/records';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	const { doc } = resolveWorkspaceContext();
	const collection = getCollection(doc, params.id);
	return { collectionId: params.id, title: collection?.title ?? 'Untitled Collection' };
};
