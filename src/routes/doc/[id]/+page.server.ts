import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { getDocument } from '$lib/data/records';
import { listCatalogCollections, listCatalogDocuments } from '$lib/server/catalog';
import { resolveParentWorkspaceContext } from '$lib/services/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	// Resolves the Document's real shard, not the default doc — a Document's
	// own meta entry lives in its own shard (see #120).
	const { doc } = resolveParentWorkspaceContext(params.id);
	const { workspaceId } = resolveWorkspaceContext();
	const document = getDocument(doc, params.id);
	return {
		documentId: params.id,
		title: document?.title ?? 'Untitled',
		// Catalog-backed, not the live Y.Doc: a sharded Document's/Collection's
		// own meta entry doesn't live in *this* Document's doc at all (#120) —
		// used for the page_link/"Add link" pickers, breadcrumb parent title,
		// and page_link target rendering. Not live, same accepted tradeoff as
		// Sidebar's lists.
		documents: listCatalogDocuments(workspaceId),
		collections: listCatalogCollections(workspaceId)
	};
};
