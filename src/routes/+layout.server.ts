import { listCatalogCollections, listCatalogDocuments } from '$lib/server/catalog';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = () => {
	const { workspaceId } = resolveWorkspaceContext();
	return {
		documents: listCatalogDocuments(workspaceId),
		collections: listCatalogCollections(workspaceId)
	};
};
