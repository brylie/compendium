import type { InternalLinkTarget } from '$lib/data/links';
import { resolveInternalLinkTarget } from '$lib/data/links';
import { listCatalogCollections, listCatalogDocuments, resolveShardForParent } from './catalog';
import { resolveWorkspaceContext } from './workspace-store';

/**
 * Resolves a Document or Collection link target against its owning workspace
 * shard. The data-layer codec uses this server-owned workspace lookup only
 * after checking its supplied Y.Doc, preserving its local fast path.
 */
export function resolveWorkspaceLinkTarget(id: string): InternalLinkTarget | undefined {
	const context = resolveWorkspaceContext();
	const shard = resolveShardForParent(context.workspaceId, id);
	const doc = shard
		? resolveWorkspaceContext({ workspaceId: context.workspaceId, shardId: shard.shardId }).doc
		: context.doc;
	return resolveInternalLinkTarget(doc, id);
}

/**
 * Resolves a wiki-link title against the workspace catalog. Local Y.Doc
 * lookup intentionally stays with the codec so ordinary same-shard links do
 * not incur a catalog read; Documents win duplicate-title ties by contract.
 */
export function resolveWorkspaceLinkId(title: string): string | undefined {
	const { workspaceId } = resolveWorkspaceContext();
	const document = listCatalogDocuments(workspaceId).find((candidate) => candidate.title === title);
	if (document) return document.id;
	return listCatalogCollections(workspaceId).find((candidate) => candidate.title === title)?.id;
}
