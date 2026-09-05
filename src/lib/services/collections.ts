import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { getDocument as crdtGetDocument } from '$lib/data/document-ops';
import {
	createCollection as crdtCreateCollection,
	deleteCollection as crdtDeleteCollection,
	getCollection as crdtGetCollection,
	resolvePrimaryField,
	updateCollectionTitle as crdtUpdateCollectionTitle
} from '$lib/data/collection-ops';
import { listRecordsForParent as crdtListRecordsForParent } from '$lib/data/record-ops';
import { logAudit } from '$lib/server/audit';
import {
	RecordIdConflictError,
	UnknownSpaceError,
	isKnownSpace,
	listCatalogCollections,
	recordCatalogCollectionCreated,
	recordCatalogCollectionDeleted,
	recordCatalogCollectionTitleChanged,
	reserveCollectionLocator
} from '$lib/server/catalog';
import { grantCollectionAccess, tokenAllowsParent } from '$lib/server/token-store';
import { listWorkspaceCollections } from '$lib/server/workspace-repository';
import type { CollectionMeta, PropertyDefinition, WorkspaceRecord } from '$lib/data/types';
import { nanoid } from 'nanoid';
import { SERVICE_ORIGIN, transactWithOrigin } from '../mutation-origin.js';
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
 * Thrown by createCollection/updateCollectionTitle when another Collection already in the
 * same Space has this title (case-insensitive, trimmed). Collections are flat (no parent
 * hierarchy to disambiguate by, unlike Documents — see documentAncestorPath in
 * document-ops.ts), so issue #78 resolves their duplicate-title ambiguity by preventing it
 * at write time instead of only surfacing it in list UIs. Scoped per-Space, not
 * workspace-wide: two Spaces each having their own "Sprint Tasks" is a normal, intended
 * pattern. Pre-existing duplicate titles (from before this check existed) are left alone —
 * this only guards new creates/renames going forward.
 */
export class DuplicateCollectionTitleError extends Error {
	constructor(title: string) {
		super(`A Collection titled "${title.trim()}" already exists in this Space`);
		this.name = 'DuplicateCollectionTitleError';
	}
}

function normalizeCollectionTitleKey(title: string): string {
	return (title || 'Untitled').trim().toLowerCase();
}

/** Throws DuplicateCollectionTitleError if another Collection in `spaceId` already has this title. Catalog-scoped only — see the class doc comment. */
function assertUniqueCollectionTitleInSpace(
	workspaceId: string,
	spaceId: string,
	title: string,
	excludeId?: string
): void {
	const key = normalizeCollectionTitleKey(title);
	const collides = listCatalogCollections(workspaceId, spaceId).some(
		(existing) => existing.id !== excludeId && normalizeCollectionTitleKey(existing.title) === key
	);
	if (collides) throw new DuplicateCollectionTitleError(title);
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
	assertUniqueCollectionTitleInSpace(workspaceId, targetSpaceId, input.title);

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

	const collection = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
		crdtCreateCollection(doc, {
			id,
			title: input.title,
			schema: input.schema ?? []
		})
	);

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
 *
 * The actual catalog-plus-fallback fan-out, including each catalog-listed
 * Collection's own-shard resolution (its full CollectionMeta — schema,
 * primaryFieldKey — isn't carried by the catalog row itself), is owned by
 * `$lib/server/workspace-repository` (#191) — shared with
 * `documents.ts#listDocuments` and `search.ts#searchWorkspace`.
 */
export function listCollections(caller: CallerIdentity, spaceId?: string): CollectionMeta[] {
	const { workspaceId, defaultSpaceId, doc: defaultDoc } = resolveWorkspaceContext();
	const allowed = (id: string, collectionSpaceId?: string) =>
		!isAccessToken(caller) || tokenAllowsParent(caller, id, collectionSpaceId);

	return listWorkspaceCollections({ workspaceId, spaceId, defaultSpaceId, defaultDoc, allowed });
}

/**
 * Resolves a Collection's schema + explicit primaryFieldKey down to the
 * actual field key a caller should treat as primary — the same fallback
 * `resolvePrimaryField` (`$lib/data/records`) applies everywhere else,
 * exposed at the service layer so the MCP tool handlers don't need their own
 * import of the data layer directly (#191: `service-layer.md` already says
 * MCP tool handlers must not call `records.ts` directly; this closed the one
 * remaining call site that did).
 */
export function resolvePrimaryFieldKey(
	schema: PropertyDefinition[],
	primaryFieldKey: string | undefined
): string | undefined {
	return resolvePrimaryField(schema, primaryFieldKey)?.key;
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
	transactWithOrigin(doc, SERVICE_ORIGIN, () => crdtDeleteCollection(doc, collectionId));
	recordCatalogCollectionDeleted(workspaceId, collectionId);
	logAudit({ actor, action: 'delete_collection', targetRecordId: collectionId });
}

/** Renames a Collection (after a permission check), updating both the Y.Doc and the catalog, and audits the change. */
export function updateCollectionTitle(
	caller: CallerIdentity,
	collectionId: string,
	title: string
): void {
	const { doc, workspaceId, parentSpaceId } = resolveParentWorkspaceContext(collectionId);
	const actor = actorForCaller(caller);

	requireAccessibleParent(caller, collectionId, 'update_collection_title');
	// parentSpaceId is undefined only for a legacy/uncataloged Collection (no
	// locator row) — nothing to scope the uniqueness check to in that case,
	// consistent with pre-existing duplicates being left alone (issue #78).
	if (parentSpaceId !== undefined) {
		assertUniqueCollectionTitleInSpace(workspaceId, parentSpaceId, title, collectionId);
	}
	transactWithOrigin(doc, SERVICE_ORIGIN, () =>
		crdtUpdateCollectionTitle(doc, collectionId, title)
	);
	recordCatalogCollectionTitleChanged(workspaceId, collectionId, title);
	logAudit({
		actor,
		action: 'update_collection_title',
		targetRecordId: collectionId,
		diff: { title }
	});
}
