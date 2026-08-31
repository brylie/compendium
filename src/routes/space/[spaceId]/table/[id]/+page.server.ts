import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { getCollection } from '$lib/data/records';
import { resolveParentWorkspaceContext } from '$lib/services/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	// Resolves the Collection's real shard, not the default doc — a
	// Collection's own meta entry lives in its own shard (see #120).
	const { doc, parentSpaceId } = resolveParentWorkspaceContext(params.id);
	// A Collection can be linked to from a different Space than the URL's own
	// [spaceId] segment (page_link/collection_view targets aren't restricted
	// to the current Space — #6 Phase A). Self-heal to the real one rather
	// than 404ing or rendering under the wrong Space; legacy/uncataloged
	// content with no locator row (parentSpaceId undefined) is left alone.
	if (parentSpaceId !== undefined && parentSpaceId !== params.spaceId) {
		redirect(
			307,
			resolve('/space/[spaceId]/table/[id]', { spaceId: parentSpaceId, id: params.id })
		);
	}
	const collection = getCollection(doc, params.id);
	return { collectionId: params.id, title: collection?.title ?? 'Untitled Collection' };
};
