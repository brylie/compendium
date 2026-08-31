import { listDocuments, listCollections } from '$lib/services';
import type { LayoutServerLoad } from './$types';

// Routed through the service layer, not the bare catalog reads directly:
// listDocuments/listCollections both fan out across the catalog *and* any
// content still written directly to a Y.Doc, bypassing the service layer
// (and therefore uncataloged) — a plain listCatalogDocuments/
// listCatalogCollections call would silently drop that content from the
// sidebar entirely, since Sidebar.svelte's own list is catalog-only (#120).
export const load: LayoutServerLoad = ({ locals }) => {
	return {
		documents: listDocuments(locals.requestContext.caller),
		collections: listCollections(locals.requestContext.caller)
	};
};
