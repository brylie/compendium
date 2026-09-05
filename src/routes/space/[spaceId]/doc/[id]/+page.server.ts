import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { getDocument } from '$lib/data/document-ops';
import { listDocuments, listCollections } from '$lib/services';
import { resolveParentWorkspaceContext } from '$lib/services/permissions';
import type { PageServerLoad } from './$types';

/**
 * Loads a Document for the doc view, self-healing the URL's [spaceId] when it
 * disagrees with the Document's actual owning Space rather than 404ing.
 */
export const load: PageServerLoad = ({ params, locals }) => {
	// Resolves the Document's real shard, not the default doc — a Document's
	// own meta entry lives in its own shard (see #120).
	const { doc, parentSpaceId } = resolveParentWorkspaceContext(params.id);
	// A Document can be linked to from a different Space than the URL's own
	// [spaceId] segment (page_link targets aren't restricted to the current
	// Space — #6 Phase A). Self-heal to the real one rather than 404ing or
	// rendering under the wrong Space; legacy/uncataloged content with no
	// locator row (parentSpaceId undefined) is left alone.
	if (parentSpaceId !== undefined && parentSpaceId !== params.spaceId) {
		redirect(307, resolve('/space/[spaceId]/doc/[id]', { spaceId: parentSpaceId, id: params.id }));
	}
	const document = getDocument(doc, params.id);
	return {
		documentId: params.id,
		title: document?.title ?? 'Untitled',
		// Routed through the service layer, not the bare catalog reads
		// directly — see +layout.server.ts's identical comment. Used for the
		// page_link/"Add link" pickers, breadcrumb parent title, and
		// page_link target rendering. Not live, same accepted tradeoff as
		// Sidebar's lists.
		documents: listDocuments(locals.requestContext.caller),
		collections: listCollections(locals.requestContext.caller)
	};
};
