import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { getDocument } from '$lib/data/records';
import { listCatalogCollections } from '$lib/server/catalog';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	const { doc, workspaceId } = resolveWorkspaceContext();
	const document = getDocument(doc, params.id);
	return {
		documentId: params.id,
		title: document?.title ?? 'Untitled',
		// Catalog-backed, not the live Y.Doc: a sharded Collection's own meta
		// entry doesn't live in this Document's doc at all. Used by
		// CollectionViewBlock's "embed a collection" picker (#120) — not live,
		// same accepted tradeoff as Sidebar's collections list.
		collections: listCatalogCollections(workspaceId)
	};
};
