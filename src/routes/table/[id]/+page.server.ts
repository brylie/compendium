import { getCollection } from '$lib/data/records';
import { resolveParentWorkspaceContext } from '$lib/services/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	// Resolves the Collection's real shard, not the default doc — a
	// Collection's own meta entry lives in its own shard (see #120).
	const { doc } = resolveParentWorkspaceContext(params.id);
	const collection = getCollection(doc, params.id);
	return { collectionId: params.id, title: collection?.title ?? 'Untitled Collection' };
};
