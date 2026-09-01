import { listDocuments, listCollections } from '$lib/services';
import { listSpaces } from '$lib/server/catalog';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import type { LayoutServerLoad } from './$types';

/**
 * Loads the Space list and the active Space's Documents/Collections for the
 * sidebar, shared by every route (not just ones nested under /space/[spaceId]).
 *
 * Routed through the service layer, not the bare catalog reads directly:
 * listDocuments/listCollections both fan out across the catalog *and* any
 * content still written directly to a Y.Doc, bypassing the service layer
 * (and therefore uncataloged) — a plain listCatalogDocuments/
 * listCatalogCollections call would silently drop that content from the
 * sidebar entirely, since Sidebar.svelte's own list is catalog-only (#120).
 *
 * Applies to every route, including ones not nested under /space/[spaceId]
 * (settings/tokens, /audit) — Sidebar renders everywhere, so activeSpaceId
 * falls back to the workspace default there rather than requiring a
 * [spaceId] param. No "last active Space" persistence yet (#6 Phase A
 * deferred scope) — those pages always show the default.
 */
export const load: LayoutServerLoad = ({ params, locals }) => {
	const { workspaceId, defaultSpaceId } = resolveWorkspaceContext();
	const activeSpaceId = params.spaceId ?? defaultSpaceId;
	return {
		spaces: listSpaces(workspaceId),
		activeSpaceId,
		documents: listDocuments(locals.requestContext.caller, activeSpaceId),
		collections: listCollections(locals.requestContext.caller, activeSpaceId)
	};
};
