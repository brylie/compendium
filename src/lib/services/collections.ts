import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import {
	createCollection as crdtCreateCollection,
	deleteCollection as crdtDeleteCollection,
	getCollection as crdtGetCollection,
	getDocument as crdtGetDocument,
	listCollections as crdtListCollections,
	listRecordsForParent as crdtListRecordsForParent,
	updateCollectionTitle as crdtUpdateCollectionTitle
} from '$lib/data/records';
import { logAudit } from '$lib/server/audit';
import {
	RecordIdConflictError,
	UnknownSpaceError,
	isKnownSpace,
	listCatalogCollections,
	recordCatalogCollectionCreated,
	recordCatalogCollectionDeleted,
	recordCatalogCollectionTitleChanged,
	reserveCollectionLocator,
	resolveShardForParent
} from '$lib/server/catalog';
import { grantCollectionAccess, tokenAllowsParent } from '$lib/mcp/tokens';
import type { CollectionMeta, PropertyDefinition, WorkspaceRecord } from '$lib/data/types';
import { nanoid } from 'nanoid';
import {
	actorForCaller,
	isAccessToken,
	requireAccessibleParent,
	resolveParentWorkspaceContext,
	type CallerIdentity
} from './permissions';

export interface CreateCollectionInput {
	id?: string;
	title: string;
	schema?: PropertyDefinition[];
	spaceId?: string;
}

/**
 * Creates a new Collection in its own shard, granting the calling token access to it and
 * auditing the creation. Guards against an id collision with anything already reachable
 * under that id — in the target shard, or written directly to the default Y.Doc bypassing
 * the service layer (and therefore the catalog locator) entirely.
 */
export function createCollection(
	caller: CallerIdentity,
	input: CreateCollectionInput
): CollectionMeta {
	const actor = actorForCaller(caller);
	const id = input.id ?? nanoid();

	// Each Collection gets its own shard, keyed by its own id (one Y.Doc per
	// Collection — see docs/specifications/workspace-sharding.md §1).
	const { doc, workspaceId, shardId, defaultSpaceId } = resolveWorkspaceContext({ shardId: id });
	const { doc: defaultDoc } = resolveWorkspaceContext();
	const targetSpaceId = input.spaceId ?? defaultSpaceId;
	// A caller-supplied spaceId must actually exist — otherwise
	// reserveCollectionLocator's insert below would fail its composite FK
	// against `spaces` and the raw DB exception would escape this call
	// uncaught (#140 CodeRabbit finding).
	if (input.spaceId !== undefined && !isKnownSpace(workspaceId, input.spaceId)) {
		throw new UnknownSpaceError(input.spaceId);
	}

	// See documents.ts's createDocument for why this also checks the live
	// Y.Doc, not just the catalog locator: a caller-supplied id could collide
	// with content created by a client writing directly to the Y.Doc,
	// bypassing the service layer (and therefore the locator) entirely.
	// Three checks, not two: a *sharded* Collection id-collision resolves to
	// this same target doc (shardId is the id itself) — crdtGetCollection(doc,
	// id) catches that directly; a Document collision can only ever be in the
	// default (unsharded) doc; and a *legacy/direct-written* Collection could
	// still be sitting in the default doc too (any client connected to the
	// shared 'workspace' room can still write there, same as before this
	// cutover — see attach-ws.ts).
	if (
		crdtGetCollection(doc, id) ||
		crdtGetDocument(defaultDoc, id) ||
		crdtGetCollection(defaultDoc, id)
	) {
		throw new RecordIdConflictError(id);
	}
	reserveCollectionLocator(workspaceId, targetSpaceId, id, shardId);

	const collection = crdtCreateCollection(doc, {
		id,
		title: input.title,
		schema: input.schema ?? []
	});

	recordCatalogCollectionCreated({
		workspaceId,
		spaceId: targetSpaceId,
		id: collection.id,
		title: collection.title,
		shardId
	});

	if (isAccessToken(caller)) {
		grantCollectionAccess(caller.tokenHash, collection.id);
		if (!caller.allowedCollectionIds.includes(collection.id)) {
			caller.allowedCollectionIds.push(collection.id);
		}
	}

	logAudit({ actor, action: 'create_collection', targetRecordId: collection.id });
	return collection;
}

/**
 * `spaceId` — see listDocuments' identical doc comment in documents.ts:
 * omitted, unchanged today's behavior; passed a non-default Space, strictly
 * catalog-scoped to it, skipping the uncataloged fallback; passed the
 * workspace's own defaultSpaceId, the fallback still runs, since uncataloged
 * content belongs there by definition (#140 CodeRabbit finding).
 */
export function listCollections(caller: CallerIdentity, spaceId?: string): CollectionMeta[] {
	const { workspaceId, defaultSpaceId, doc: defaultDoc } = resolveWorkspaceContext();
	const allowed = (id: string, collectionSpaceId?: string) =>
		!isAccessToken(caller) || tokenAllowsParent(caller, id, collectionSpaceId);

	// Catalog-listed Collections first — each one's own shard resolved from
	// the locator, since a sharded Collection's own meta entry (not just its
	// rows) can live outside the default doc's collections map. Full
	// CollectionMeta (schema, primaryFieldKey — not carried by the catalog
	// itself) is read from its real resolved shard, mirroring search.ts's
	// catalog-then-per-shard-fanout.
	const catalogCollectionIds = new Set<string>();
	const results: CollectionMeta[] = [];
	for (const meta of listCatalogCollections(workspaceId, spaceId)) {
		catalogCollectionIds.add(meta.id);
		if (!allowed(meta.id, meta.spaceId)) continue;
		const shard = resolveShardForParent(workspaceId, meta.id);
		const collectionDoc = shard
			? resolveWorkspaceContext({ workspaceId, shardId: shard.shardId }).doc
			: defaultDoc;
		const fullMeta = crdtGetCollection(collectionDoc, meta.id);
		results.push(fullMeta ? { ...fullMeta, spaceId: meta.spaceId } : meta);
	}

	if (spaceId !== undefined && spaceId !== defaultSpaceId) return results;

	// Then any Collection written directly to the Y.Doc, bypassing the
	// service layer entirely (and therefore uncataloged) — the catalog loop
	// above can't see these; they're only findable in the default doc.
	for (const collection of crdtListCollections(defaultDoc)) {
		if (catalogCollectionIds.has(collection.id)) continue;
		// Uncataloged content is classified as belonging to defaultSpaceId (see
		// this function's own doc comment) — passing it here too, not just
		// omitting it, so a token whose only grant is a Space-level allowlist
		// for the default Space (no per-Collection grant) can actually see it
		// (CodeRabbit finding on #141's merge with #140).
		if (!allowed(collection.id, defaultSpaceId)) continue;
		results.push(collection);
	}

	return results;
}

/** Returns a Collection's metadata and all its rows, after checking `caller` may access it. */
export function queryCollection(
	caller: CallerIdentity,
	collectionId: string
): {
	collection: CollectionMeta | undefined;
	records: WorkspaceRecord[];
} {
	const { doc } = resolveParentWorkspaceContext(collectionId);
	const actor = actorForCaller(caller);

	requireAccessibleParent(caller, collectionId, 'query_collection');
	const collection = crdtGetCollection(doc, collectionId);
	const records = crdtListRecordsForParent(doc, collectionId);

	logAudit({ actor, action: 'query_collection', targetRecordId: collectionId });
	return { collection, records };
}

/** Deletes a Collection (after a permission check), removing it from both the Y.Doc and the catalog, and audits the deletion. */
export function deleteCollection(caller: CallerIdentity, collectionId: string): void {
	const { doc, workspaceId } = resolveParentWorkspaceContext(collectionId);
	const actor = actorForCaller(caller);

	requireAccessibleParent(caller, collectionId, 'delete_collection');
	crdtDeleteCollection(doc, collectionId);
	recordCatalogCollectionDeleted(workspaceId, collectionId);
	logAudit({ actor, action: 'delete_collection', targetRecordId: collectionId });
}

/** Renames a Collection (after a permission check), updating both the Y.Doc and the catalog, and audits the change. */
export function updateCollectionTitle(
	caller: CallerIdentity,
	collectionId: string,
	title: string
): void {
	const { doc, workspaceId } = resolveParentWorkspaceContext(collectionId);
	const actor = actorForCaller(caller);

	requireAccessibleParent(caller, collectionId, 'update_collection_title');
	crdtUpdateCollectionTitle(doc, collectionId, title);
	recordCatalogCollectionTitleChanged(workspaceId, collectionId, title);
	logAudit({
		actor,
		action: 'update_collection_title',
		targetRecordId: collectionId,
		diff: { title }
	});
}
