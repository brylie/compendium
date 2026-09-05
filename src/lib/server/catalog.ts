import * as Y from 'yjs';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getDb } from './store.js';
import type { Db } from './db/index.js';
import {
	catalogCollections,
	catalogDocuments,
	catalogOutbox,
	catalogRevisions,
	recordLocator,
	spaces
} from './db/schema.js';
import { listDocuments as crdtListDocuments } from '../data/document-ops.js';
import { listCollections as crdtListCollections } from '../data/collection-ops.js';
import type { CollectionMeta, DocumentMeta, ParentKind, SpaceMeta } from '../data/types.js';

// The transaction handle drizzle's better-sqlite3 driver passes into a
// db.transaction(...) callback — extracted from Db['transaction'] itself
// rather than hand-typed, so it can't drift from the real type.
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

// The catalog: durable SQLite metadata fronting the (today: single, Phase B:
// per-Document/per-Collection) Y.Doc content shard(s) — see
// docs/specifications/workspace-sharding.md §3.1. Phase A dual-writes this
// alongside every service-layer Document/Collection mutation, without yet
// splitting the Y.Doc itself (every row's shardId stays 'default'). Placed
// under src/lib/server/, not src/lib/services/, so it is never picked up by
// src/lib/services/manifest.ts's MCP tool-surface registration.

/** Thrown by `reserveLocator` when the requested record id already exists in this workspace. */
export class RecordIdConflictError extends Error {
	constructor(recordId: string) {
		super(`Record id ${recordId} already exists in this workspace`);
		this.name = 'RecordIdConflictError';
	}
}

/** Thrown when a given spaceId doesn't correspond to a real Space in this workspace. */
export class UnknownSpaceError extends Error {
	constructor(spaceId: string) {
		super(`Space ${spaceId} does not exist in this workspace`);
		this.name = 'UnknownSpaceError';
	}
}

type CatalogOp = 'create' | 'update' | 'move' | 'delete';

/**
 * Bumps the workspace's catalog revision and appends its outbox row.
 * Takes the caller's own transaction handle rather than opening one itself,
 * so a crash between the catalog mutation, the revision bump, and the
 * outbox insert can never leave any of the three committed without the
 * others — the committed-write contract (workspace-sharding.md §4) this
 * exists to guarantee would otherwise be undermined by exactly that gap.
 */
function bumpRevisionAndAppendOutbox(
	tx: Tx,
	workspaceId: string,
	payload: { documents?: string[]; collections?: string[]; op: CatalogOp }
): void {
	tx.insert(catalogRevisions)
		.values({ workspaceId, revision: 1 })
		.onConflictDoUpdate({
			target: catalogRevisions.workspaceId,
			set: { revision: sql`${catalogRevisions.revision} + 1` }
		})
		.run();
	const revision =
		tx
			.select({ revision: catalogRevisions.revision })
			.from(catalogRevisions)
			.where(eq(catalogRevisions.workspaceId, workspaceId))
			.get()?.revision ?? 1;
	const now = Date.now();
	tx.insert(catalogOutbox)
		.values({
			workspaceId,
			revision,
			status: 'published',
			operationId: nanoid(),
			payload,
			createdAt: now,
			publishedAt: now
		})
		.run();
}

/**
 * Reserves `id` in the workspace-wide record locator before any content is
 * written for it — the mechanism behind §3.1's "a duplicate
 * (workspace_id, record_id) is rejected." Throws RecordIdConflictError
 * *before* the Y.Doc is touched on a collision, replacing the prior
 * silent-overwrite-on-duplicate-id behavior of data/records.ts's
 * createDocument/createCollection.
 */
type LocatorKind = ParentKind | 'record';

function reserveLocator(
	workspaceId: string,
	spaceId: string,
	recordId: string,
	kind: LocatorKind,
	shardId: string
): void {
	try {
		getDb()
			.insert(recordLocator)
			.values({ workspaceId, recordId, kind, spaceId, shardId, createdAt: Date.now() })
			.run();
	} catch (err) {
		if (err instanceof Error && err.message.includes('UNIQUE constraint failed')) {
			throw new RecordIdConflictError(recordId);
		}
		throw err;
	}
}

/** Reserves a locator entry for a new Document id, guarding against duplicate ids across the workspace. */
export function reserveDocumentLocator(
	workspaceId: string,
	spaceId: string,
	id: string,
	shardId: string
): void {
	reserveLocator(workspaceId, spaceId, id, 'document', shardId);
}

/** Reserves a locator entry for a new Collection id, guarding against duplicate ids across the workspace. */
export function reserveCollectionLocator(
	workspaceId: string,
	spaceId: string,
	id: string,
	shardId: string
): void {
	reserveLocator(workspaceId, spaceId, id, 'collection', shardId);
}

/**
 * Reserves a locator entry for one record/row within a sharded Collection —
 * unlike Documents/Collections, individual records aren't catalog-navigable
 * entities (§3.1), so this exists purely so write_record/delete_record/
 * hold_records/release_records (which only ever receive a bare recordId, no
 * parent hint) can resolve which shard to operate against. Document blocks
 * are never locator-tracked — they're always in the default shard as long
 * as Documents themselves aren't sharded, so resolveShardForRecord's
 * "not found" fallback already routes them correctly.
 */
export function reserveRecordLocator(
	workspaceId: string,
	spaceId: string,
	recordId: string,
	shardId: string
): void {
	reserveLocator(workspaceId, spaceId, recordId, 'record', shardId);
}

/** Removes a record/row's locator entry, the counterpart to `reserveRecordLocator` (e.g. on delete). */
export function releaseRecordLocator(workspaceId: string, recordId: string): void {
	getDb()
		.delete(recordLocator)
		.where(and(eq(recordLocator.workspaceId, workspaceId), eq(recordLocator.recordId, recordId)))
		.run();
}

/**
 * Resolves the shard a Document or Collection lives in, for callers that
 * already have its own id (query_collection's collectionId, create_record's
 * parentId). Returns undefined when untracked — content written directly to
 * the Y.Doc, bypassing the service layer, or an id that doesn't exist —
 * callers fall back to the default context in that case.
 */
export function resolveShardForParent(
	workspaceId: string,
	parentId: string
): { shardId: string; kind: 'document' | 'collection'; spaceId: string } | undefined {
	const row = getDb()
		.select({
			shardId: recordLocator.shardId,
			kind: recordLocator.kind,
			spaceId: recordLocator.spaceId
		})
		.from(recordLocator)
		.where(and(eq(recordLocator.workspaceId, workspaceId), eq(recordLocator.recordId, parentId)))
		.get();
	if (!row || row.kind === 'record') return undefined;
	return { shardId: row.shardId, kind: row.kind, spaceId: row.spaceId };
}

/** Resolves the shard a single record/row lives in, for callers that only have a bare recordId. */
export function resolveShardForRecord(
	workspaceId: string,
	recordId: string
): { shardId: string } | undefined {
	const row = getDb()
		.select({ shardId: recordLocator.shardId })
		.from(recordLocator)
		.where(and(eq(recordLocator.workspaceId, workspaceId), eq(recordLocator.recordId, recordId)))
		.get();
	return row ? { shardId: row.shardId } : undefined;
}

/**
 * True when `shardId` is a real Document or Collection's own shard — i.e.
 * *some* row in the locator was actually assigned there (#111/#138's
 * WebSocket shard-room validation). Deliberately keyed by
 * `recordLocator.shardId`, not `recordId`: a caller here only has the
 * server-issued shard id (from GET /api/documents/[id]/shard or
 * /api/collections/[id]/shard), which is **not** always equal to the resource's own id — a pre-migration
 * Document/Collection still resolves to the shared default shard (see that
 * endpoint's own comment), so checking `recordId = shardId` would wrongly
 * reject every legitimate connection to un-migrated content.
 */
export function isKnownShard(workspaceId: string, shardId: string): boolean {
	const row = getDb()
		.select({ id: recordLocator.id })
		.from(recordLocator)
		.where(
			and(
				eq(recordLocator.workspaceId, workspaceId),
				eq(recordLocator.shardId, shardId),
				inArray(recordLocator.kind, ['document', 'collection'])
			)
		)
		.get();
	return row !== undefined;
}

/**
 * True when `spaceId` is a real Space in this workspace (#6) — used to
 * validate a client-supplied `[spaceId]` route param before trusting it,
 * the same "verify before use" posture as isKnownShard above.
 */
export function isKnownSpace(workspaceId: string, spaceId: string): boolean {
	const row = getDb()
		.select({ id: spaces.id })
		.from(spaces)
		.where(and(eq(spaces.workspaceId, workspaceId), eq(spaces.id, spaceId)))
		.get();
	return row !== undefined;
}

/** Dual-writes a newly created Document into the catalog and bumps the workspace's catalog revision. */
export function recordCatalogDocumentCreated(input: {
	workspaceId: string;
	spaceId: string;
	id: string;
	title: string;
	parentDocumentId?: string;
	order: string;
	shardId: string;
}): void {
	const now = Date.now();
	getDb().transaction((tx) => {
		tx.insert(catalogDocuments)
			.values({
				id: input.id,
				workspaceId: input.workspaceId,
				spaceId: input.spaceId,
				shardId: input.shardId,
				title: input.title,
				parentDocumentId: input.parentDocumentId,
				order: input.order,
				createdAt: now,
				updatedAt: now
			})
			.run();
		bumpRevisionAndAppendOutbox(tx, input.workspaceId, { documents: [input.id], op: 'create' });
	});
}

/** Mirrors a Document's title change into the catalog and bumps the workspace's catalog revision. */
export function recordCatalogDocumentTitleChanged(
	workspaceId: string,
	id: string,
	title: string
): void {
	getDb().transaction((tx) => {
		tx.update(catalogDocuments)
			.set({ title, updatedAt: Date.now() })
			.where(and(eq(catalogDocuments.workspaceId, workspaceId), eq(catalogDocuments.id, id)))
			.run();
		bumpRevisionAndAppendOutbox(tx, workspaceId, { documents: [id], op: 'update' });
	});
}

/** Mirrors a Document's reparent/reorder into the catalog and bumps the workspace's catalog revision. */
export function recordCatalogDocumentMoved(
	workspaceId: string,
	id: string,
	parentDocumentId: string | undefined,
	order: string
): void {
	getDb().transaction((tx) => {
		tx.update(catalogDocuments)
			.set({ parentDocumentId: parentDocumentId ?? null, order, updatedAt: Date.now() })
			.where(and(eq(catalogDocuments.workspaceId, workspaceId), eq(catalogDocuments.id, id)))
			.run();
		bumpRevisionAndAppendOutbox(tx, workspaceId, { documents: [id], op: 'move' });
	});
}

/**
 * Projects a document's catalog-owned metadata in one SQLite transaction.
 * Used for direct Yjs edits, where title and hierarchy can change together.
 */
export function recordCatalogDocumentMetadataChanged(
	workspaceId: string,
	id: string,
	metadata: { title: string; parentDocumentId?: string; order: string }
): void {
	getDb().transaction((tx) => {
		tx.update(catalogDocuments)
			.set({
				title: metadata.title,
				parentDocumentId: metadata.parentDocumentId ?? null,
				order: metadata.order,
				updatedAt: Date.now()
			})
			.where(and(eq(catalogDocuments.workspaceId, workspaceId), eq(catalogDocuments.id, id)))
			.run();
		bumpRevisionAndAppendOutbox(tx, workspaceId, { documents: [id], op: 'update' });
	});
}

/**
 * Repairs catalog metadata from the authoritative Yjs document. It performs
 * only value-changing writes, making repeated calls safe after a failed
 * immediate projection or process restart.
 */
export function reconcileCatalogMetadata(workspaceId: string, doc: Y.Doc): void {
	const catalogDocumentsById = new Map(
		listCatalogDocuments(workspaceId).map((meta) => [meta.id, meta])
	);
	for (const meta of crdtListDocuments(doc)) {
		const catalog = catalogDocumentsById.get(meta.id);
		if (
			catalog &&
			(catalog.title !== meta.title ||
				catalog.parentDocumentId !== meta.parentDocumentId ||
				catalog.order !== meta.order)
		) {
			recordCatalogDocumentMetadataChanged(workspaceId, meta.id, meta);
		}
	}

	const catalogCollectionsById = new Map(
		listCatalogCollections(workspaceId).map((meta) => [meta.id, meta])
	);
	for (const meta of crdtListCollections(doc)) {
		const catalog = catalogCollectionsById.get(meta.id);
		if (catalog && catalog.title !== meta.title) {
			recordCatalogCollectionTitleChanged(workspaceId, meta.id, meta.title);
		}
	}
}

/**
 * Deletes a Document and its descendants from the catalog, mirroring
 * data/records.ts's recursive deleteDocument. Walks the *catalog's own*
 * parent chain (via a recursive CTE — drizzle's typed query builder has no
 * WITH RECURSIVE support) rather than re-deriving it from the Y.Doc; these
 * should always agree since every prior create/move immediately mirrors into
 * the catalog, but a prior undetected divergence would under-cascade here.
 * A no-op (not an error) if `id` has no catalog row at all — e.g. it was
 * created by a client writing directly to the Y.Doc, bypassing the service
 * layer (see parentDocumentId's comment in db/schema.ts).
 */
export function recordCatalogDocumentDeleted(workspaceId: string, id: string): void {
	const db = getDb();
	const descendants = db.all<{ id: string }>(sql`
		WITH RECURSIVE descendants(id) AS (
			SELECT id FROM catalog_documents WHERE id = ${id} AND workspace_id = ${workspaceId}
			UNION ALL
			SELECT catalog_documents.id FROM catalog_documents
			JOIN descendants ON catalog_documents.parent_document_id = descendants.id
			WHERE catalog_documents.workspace_id = ${workspaceId}
		)
		SELECT id FROM descendants
	`);
	const ids = descendants.map((row) => row.id);
	if (ids.length === 0) return;

	db.transaction((tx) => {
		for (const docId of ids) {
			tx.delete(recordLocator)
				.where(and(eq(recordLocator.workspaceId, workspaceId), eq(recordLocator.recordId, docId)))
				.run();
		}
		// parentDocumentId isn't a real FK (see db/schema.ts), so every
		// descendant is deleted explicitly rather than relying on a cascade.
		tx.delete(catalogDocuments)
			.where(and(eq(catalogDocuments.workspaceId, workspaceId), inArray(catalogDocuments.id, ids)))
			.run();
		bumpRevisionAndAppendOutbox(tx, workspaceId, { documents: ids, op: 'delete' });
	});
}

/** Dual-writes a newly created Collection into the catalog and bumps the workspace's catalog revision. */
export function recordCatalogCollectionCreated(input: {
	workspaceId: string;
	spaceId: string;
	id: string;
	title: string;
	shardId: string;
}): void {
	const now = Date.now();
	getDb().transaction((tx) => {
		tx.insert(catalogCollections)
			.values({
				id: input.id,
				workspaceId: input.workspaceId,
				spaceId: input.spaceId,
				shardId: input.shardId,
				title: input.title,
				createdAt: now,
				updatedAt: now
			})
			.run();
		bumpRevisionAndAppendOutbox(tx, input.workspaceId, { collections: [input.id], op: 'create' });
	});
}

/** Mirrors a Collection's title change into the catalog and bumps the workspace's catalog revision. */
export function recordCatalogCollectionTitleChanged(
	workspaceId: string,
	id: string,
	title: string
): void {
	getDb().transaction((tx) => {
		tx.update(catalogCollections)
			.set({ title, updatedAt: Date.now() })
			.where(and(eq(catalogCollections.workspaceId, workspaceId), eq(catalogCollections.id, id)))
			.run();
		bumpRevisionAndAppendOutbox(tx, workspaceId, { collections: [id], op: 'update' });
	});
}

/** Removes a Collection's catalog row and locator entry, and bumps the workspace's catalog revision. */
export function recordCatalogCollectionDeleted(workspaceId: string, id: string): void {
	getDb().transaction((tx) => {
		tx.delete(recordLocator)
			.where(and(eq(recordLocator.workspaceId, workspaceId), eq(recordLocator.recordId, id)))
			.run();
		tx.delete(catalogCollections)
			.where(and(eq(catalogCollections.workspaceId, workspaceId), eq(catalogCollections.id, id)))
			.run();
		bumpRevisionAndAppendOutbox(tx, workspaceId, { collections: [id], op: 'delete' });
	});
}

/**
 * `spaceId` is optional and additive to the existing (workspaceId-only)
 * behavior every current caller relies on — omitted, this returns every
 * Document in the workspace exactly as before Phase 0's single-Space reality
 * made a filter unnecessary. Passed, it scopes to just that Space — the
 * mechanism behind #133's isolation proof (docs/specifications/
 * workspace-sharding.md §9: "UI and MCP operations enforce the same catalog,
 * Space, and shard scope").
 */
export function listCatalogDocuments(workspaceId: string, spaceId?: string): DocumentMeta[] {
	return getDb()
		.select()
		.from(catalogDocuments)
		.where(
			spaceId !== undefined
				? and(eq(catalogDocuments.workspaceId, workspaceId), eq(catalogDocuments.spaceId, spaceId))
				: eq(catalogDocuments.workspaceId, workspaceId)
		)
		.all()
		.map((row) => ({
			id: row.id,
			title: row.title,
			parentDocumentId: row.parentDocumentId ?? undefined,
			order: row.order,
			recordIds: [],
			spaceId: row.spaceId
		}))
		.sort((a, b) => a.order.localeCompare(b.order));
}

/** Lists Collections from the catalog, optionally scoped to a single Space (see `listCatalogDocuments`). */
export function listCatalogCollections(workspaceId: string, spaceId?: string): CollectionMeta[] {
	return getDb()
		.select()
		.from(catalogCollections)
		.where(
			spaceId !== undefined
				? and(
						eq(catalogCollections.workspaceId, workspaceId),
						eq(catalogCollections.spaceId, spaceId)
					)
				: eq(catalogCollections.workspaceId, workspaceId)
		)
		.all()
		.map((row) => ({
			id: row.id,
			title: row.title,
			schema: [],
			recordIds: [],
			spaceId: row.spaceId
		}));
}

/**
 * Creates an additional Space in this workspace — not exposed through any
 * MCP tool or UI yet (that's #6's Space-switcher/creation surface), but a
 * real, durable Space a caller with its id can create content in and query
 * against. Exists so #133's isolation tests can construct a genuine
 * multi-Space fixture without waiting on #6's product surface.
 */
export function createSpace(workspaceId: string, name: string): SpaceMeta {
	const id = nanoid();
	getDb().insert(spaces).values({ id, workspaceId, name, createdAt: Date.now() }).run();
	return { id, workspaceId, name };
}

/** Lists every Space in a workspace, ordered by creation. */
export function listSpaces(workspaceId: string): SpaceMeta[] {
	return getDb()
		.select({ id: spaces.id, workspaceId: spaces.workspaceId, name: spaces.name })
		.from(spaces)
		.where(eq(spaces.workspaceId, workspaceId))
		.orderBy(sql`rowid`)
		.all();
}

/**
 * Ensures the catalog has a default Space for this workspace, backfilling it
 * from the Y.Doc's current Documents/Collections the first time this
 * resolves (idempotent via a durable-state check, not an in-memory flag —
 * safe even if called more than once). This is a narrow dev/test
 * convenience for Phase A's existing local data, NOT §7's versioned,
 * checksum-verified production migration (that is #114's job).
 */
export function ensureCatalogBootstrapped(
	workspaceId: string,
	shardId: string,
	doc: Y.Doc
): { defaultSpaceId: string } {
	const db = getDb();
	// Ordered by rowid (SQLite's own insertion-order column, present on every
	// rowid table regardless of its declared primary key) so this always
	// resolves to the *first* Space ever created for this workspace, even
	// once createSpace (#133) has added others — a bare `.get()` with no
	// ORDER BY has no defined row order once more than one match exists, and
	// would non-deterministically return whichever Space's id happened to
	// come back first, silently misattributing new content's spaceId.
	const existing = db
		.select({ id: spaces.id })
		.from(spaces)
		.where(eq(spaces.workspaceId, workspaceId))
		.orderBy(sql`rowid`)
		.limit(1)
		.get();
	if (existing) return { defaultSpaceId: existing.id };

	const defaultSpaceId = nanoid();
	const now = Date.now();
	const existingDocs = crdtListDocuments(doc);
	const existingCollections = crdtListCollections(doc);

	db.transaction((tx) => {
		tx.insert(spaces)
			.values({ id: defaultSpaceId, workspaceId, name: 'Default', createdAt: now })
			.run();
		tx.insert(catalogRevisions).values({ workspaceId, revision: 0 }).run();

		for (const d of existingDocs) {
			tx.insert(recordLocator)
				.values({
					workspaceId,
					recordId: d.id,
					kind: 'document',
					spaceId: defaultSpaceId,
					shardId,
					createdAt: now
				})
				.run();
			tx.insert(catalogDocuments)
				.values({
					id: d.id,
					workspaceId,
					spaceId: defaultSpaceId,
					shardId,
					title: d.title,
					parentDocumentId: d.parentDocumentId,
					order: d.order,
					createdAt: now,
					updatedAt: now
				})
				.run();
		}
		for (const c of existingCollections) {
			tx.insert(recordLocator)
				.values({
					workspaceId,
					recordId: c.id,
					kind: 'collection',
					spaceId: defaultSpaceId,
					shardId,
					createdAt: now
				})
				.run();
			tx.insert(catalogCollections)
				.values({
					id: c.id,
					workspaceId,
					spaceId: defaultSpaceId,
					shardId,
					title: c.title,
					createdAt: now,
					updatedAt: now
				})
				.run();
		}
	});

	return { defaultSpaceId };
}
