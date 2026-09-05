import type * as Y from 'yjs';
import { resolveWorkspaceContext } from './workspace-store';
import { resolveShardForParent, listCatalogCollections, listCatalogDocuments } from './catalog';
import {
	getCollection as crdtGetCollection,
	listCollections as crdtListCollections,
	listDocuments as crdtListDocuments
} from '$lib/data/records';
import type { CollectionMeta, DocumentMeta } from '$lib/data/types';

/** One fanned-out catalog/uncataloged item, paired with the `Y.Doc` it actually lives in. */
export interface WorkspaceFanoutItem<TMeta> {
	meta: TMeta;
	doc: Y.Doc;
}

interface FanOutOptions<TMeta> {
	workspaceId: string;
	spaceId?: string;
	defaultSpaceId: string;
	defaultDoc: Y.Doc;
	listCatalog: (workspaceId: string, spaceId?: string) => TMeta[];
	listUncataloged: (doc: Y.Doc) => TMeta[];
	getId: (meta: TMeta) => string;
	getSpaceId: (meta: TMeta) => string | undefined;
	allowed: (id: string, spaceId?: string) => boolean;
	/**
	 * Catalog-listed Documents already carry everything a plain listing needs
	 * (title/parentDocumentId/order) straight from the catalog row, so
	 * resolving each one's real shard would be a pure-overhead locator lookup
	 * with nothing to show for it. Collections' catalog row doesn't carry
	 * schema/primaryFieldKey, and search needs to scan a shard's actual block
	 * content — both set this to resolve each catalog item's real `doc`
	 * (falling back to `defaultDoc` for anything with no locator row).
	 */
	resolveShardDoc?: boolean;
}

/**
 * The "catalog-first, then uncataloged-default-fallback" fan-out that
 * Document listing, Collection listing, and search each re-implemented
 * independently before #191 — including the permission filter and the
 * Space-scoping guard (skip the uncataloged fallback for a genuinely
 * different Space; still run it for the workspace's own default Space,
 * since uncataloged content is classified as belonging there by definition).
 * One owner for all three, so a caller can no longer drift from the other
 * two the way `search.ts`'s independent copy of this guard once did.
 */
export function fanOutCatalogedAndUncataloged<TMeta>(
	opts: FanOutOptions<TMeta>
): WorkspaceFanoutItem<TMeta>[] {
	const {
		workspaceId,
		spaceId,
		defaultSpaceId,
		defaultDoc,
		listCatalog,
		listUncataloged,
		getId,
		getSpaceId,
		allowed,
		resolveShardDoc
	} = opts;

	const catalogIds = new Set<string>();
	const results: WorkspaceFanoutItem<TMeta>[] = [];

	for (const meta of listCatalog(workspaceId, spaceId)) {
		const id = getId(meta);
		catalogIds.add(id);
		if (!allowed(id, getSpaceId(meta))) continue;
		let doc = defaultDoc;
		if (resolveShardDoc) {
			const shard = resolveShardForParent(workspaceId, id);
			if (shard) doc = resolveWorkspaceContext({ workspaceId, shardId: shard.shardId }).doc;
		}
		results.push({ meta, doc });
	}

	// A non-default Space was explicitly requested: uncataloged content has
	// no reliably known Space membership to check (no locator row), so
	// including it here would risk leaking it into a Space it may not
	// belong to (#133) — strictly catalog-scoped in that case.
	if (spaceId !== undefined && spaceId !== defaultSpaceId) return results;

	for (const meta of listUncataloged(defaultDoc)) {
		const id = getId(meta);
		if (catalogIds.has(id)) continue;
		// Uncataloged content is classified as belonging to defaultSpaceId —
		// passed explicitly (not just omitted) so a token whose only grant is
		// a Space-level allowlist for the default Space, with no per-item
		// grant, still matches.
		if (!allowed(id, defaultSpaceId)) continue;
		results.push({ meta, doc: defaultDoc });
	}

	return results;
}

interface ListWorkspaceItemsOptions {
	workspaceId: string;
	spaceId?: string;
	defaultSpaceId: string;
	defaultDoc: Y.Doc;
	allowed: (id: string, spaceId?: string) => boolean;
}

/** Every Document in the workspace the caller may see — catalog plus uncataloged fallback. */
export function listWorkspaceDocuments(opts: ListWorkspaceItemsOptions): DocumentMeta[] {
	return fanOutCatalogedAndUncataloged({
		...opts,
		listCatalog: listCatalogDocuments,
		listUncataloged: crdtListDocuments,
		getId: (m) => m.id,
		getSpaceId: (m) => m.spaceId
	}).map((item) => item.meta);
}

/** Every Collection in the workspace the caller may see — catalog plus uncataloged fallback. */
export function listWorkspaceCollections(opts: ListWorkspaceItemsOptions): CollectionMeta[] {
	return fanOutCatalogedAndUncataloged({
		...opts,
		listCatalog: listCatalogCollections,
		listUncataloged: crdtListCollections,
		getId: (m) => m.id,
		getSpaceId: (m) => m.spaceId,
		resolveShardDoc: true
	}).map(({ meta, doc }) => {
		// The catalog row doesn't carry schema/primaryFieldKey — re-read the
		// full CollectionMeta from wherever it actually lives (its own shard,
		// per #120). Harmless no-op re-read for uncataloged items, which are
		// already the full CollectionMeta straight from `defaultDoc`.
		const fullMeta = crdtGetCollection(doc, meta.id);
		return fullMeta ? { ...fullMeta, spaceId: meta.spaceId } : meta;
	});
}
