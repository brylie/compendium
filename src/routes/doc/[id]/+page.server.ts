import { getDocument } from '$lib/data/records';
import { listDocuments, listCollections } from '$lib/services';
import { resolveParentWorkspaceContext } from '$lib/services/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params, locals }) => {
	// Resolves the Document's real shard, not the default doc — a Document's
	// own meta entry lives in its own shard (see #120).
	const { doc } = resolveParentWorkspaceContext(params.id);
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
