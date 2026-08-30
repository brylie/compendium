import {
	blob,
	foreignKey,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex
} from 'drizzle-orm/sqlite-core';
import type { ActorId } from '$lib/data/types';

export const snapshots = sqliteTable('snapshots', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	// Phase 0 has exactly one workspace/shard, so both columns default to the
	// same constant (src/lib/server/workspace-store.ts's DEFAULT_WORKSPACE_ID /
	// DEFAULT_SHARD_ID) for every row today — but the column exists now so
	// #13's real sharding work is a query-scoping change, not a migration.
	workspaceId: text('workspace_id').notNull().default('default'),
	shardId: text('shard_id').notNull().default('default'),
	state: blob('state', { mode: 'buffer' }).notNull(),
	createdAt: integer('created_at').notNull()
});

export const auditLog = sqliteTable('audit_log', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	actor: text('actor_json', { mode: 'json' }).notNull().$type<ActorId>(),
	action: text('action').notNull(),
	targetRecordId: text('target_record_id'),
	timestamp: integer('timestamp').notNull(),
	diff: text('diff_json', { mode: 'json' }).$type<unknown>()
});

export const accessTokens = sqliteTable('access_tokens', {
	tokenHash: text('token_hash').primaryKey(),
	clientLabel: text('client_label').notNull(),
	allowedDocumentIds: text('allowed_document_ids', { mode: 'json' }).notNull().$type<string[]>(),
	allowedCollectionIds: text('allowed_collection_ids', { mode: 'json' })
		.notNull()
		.$type<string[]>(),
	createdAt: integer('created_at').notNull(),
	revokedAt: integer('revoked_at')
});

// --- Workspace catalog (docs/specifications/workspace-sharding.md, #113 Phase A) ---
//
// The catalog is the durable, server-owned source of truth for Space/Document/
// Collection identity, title, and hierarchy — kept in sync by dual-writing from
// the service layer alongside each Y.Doc mutation (see src/lib/server/catalog.ts).
// Phase A keeps every row's shardId at 'default' (the one real content shard
// today); the column exists now so Phase B's real per-Document/per-Collection
// shard split is a query-scoping change, not another migration.

export const spaces = sqliteTable(
	'spaces',
	{
		id: text('id').primaryKey(),
		workspaceId: text('workspace_id').notNull().default('default'),
		name: text('name').notNull(),
		createdAt: integer('created_at').notNull()
	},
	// (workspaceId, id) is already implied unique by id's own global PK, but
	// SQLite still requires an explicit unique constraint on exactly this
	// column tuple to be the target of a composite foreign key below.
	(t) => [uniqueIndex('spaces_workspace_id_unique').on(t.workspaceId, t.id)]
);

// Primary key is (workspaceId, id), not bare id: record_locator scopes
// uniqueness the same way (a recordId is only unique *within* a workspace),
// so a bare global id PK here would throw on an otherwise-valid second
// workspace reusing the same id — the locator would have already accepted
// the reservation.
export const catalogDocuments = sqliteTable(
	'catalog_documents',
	{
		id: text('id').notNull(), // == the Y.Doc DocumentMeta.id it mirrors
		workspaceId: text('workspace_id').notNull().default('default'),
		spaceId: text('space_id').notNull(),
		shardId: text('shard_id').notNull().default('default'),
		title: text('title').notNull(),
		// Deliberately NOT a foreign key: a Document can be created by a client
		// writing directly to the Y.Doc over Yjs sync, bypassing the service layer
		// entirely (a supported pattern — see docs/specifications/audit-coverage.md
		// and tests/e2e/tier-a.test.ts's direct-Yjs-client cases). Its catalog row
		// wouldn't exist yet, so a strict FK on a real parentDocumentId would throw
		// on an otherwise-valid nested create. recordCatalogDocumentDeleted (see
		// catalog.ts) therefore deletes descendants explicitly rather than relying
		// on ON DELETE CASCADE.
		parentDocumentId: text('parent_document_id'),
		order: text('order').notNull(), // mirrors DocumentMeta.order exactly, never independently recomputed
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [
		primaryKey({ columns: [t.workspaceId, t.id] }),
		// Composite, not a plain spaceId -> spaces.id reference: a bare
		// reference would let this row's workspaceId disagree with the
		// referenced Space's own workspaceId (spaces.id alone is globally
		// unique, so it can't catch that mismatch on its own).
		foreignKey({
			columns: [t.workspaceId, t.spaceId],
			foreignColumns: [spaces.workspaceId, spaces.id]
		})
	]
);

export const catalogCollections = sqliteTable(
	'catalog_collections',
	{
		id: text('id').notNull(), // == the Y.Doc CollectionMeta.id it mirrors
		workspaceId: text('workspace_id').notNull().default('default'),
		spaceId: text('space_id').notNull(),
		shardId: text('shard_id').notNull().default('default'),
		title: text('title').notNull(),
		// No parent/order (Collections are flat) and no schema mirror — schema
		// stays shard-owned per workspace-sharding.md §3.1/§3.2.
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [
		primaryKey({ columns: [t.workspaceId, t.id] }),
		foreignKey({
			columns: [t.workspaceId, t.spaceId],
			foreignColumns: [spaces.workspaceId, spaces.id]
		})
	]
);

// The workspace-wide (workspace_id, record_id) locator required by §3.1: the
// mechanism that actually rejects a duplicate id across Documents/Collections
// (today's separate Y.Maps for each don't prevent that at all). Also covers
// individual records/rows within a sharded Collection ('record' kind) — see
// reserveRecordLocator in catalog.ts.
export const recordLocator = sqliteTable(
	'record_locator',
	{
		id: integer('id').primaryKey({ autoIncrement: true }),
		workspaceId: text('workspace_id').notNull().default('default'),
		recordId: text('record_id').notNull(),
		kind: text('kind').notNull().$type<'document' | 'collection' | 'record'>(),
		spaceId: text('space_id').notNull(),
		shardId: text('shard_id').notNull().default('default'),
		createdAt: integer('created_at').notNull()
	},
	(t) => [
		uniqueIndex('record_locator_workspace_record_unique').on(t.workspaceId, t.recordId),
		foreignKey({
			columns: [t.workspaceId, t.spaceId],
			foreignColumns: [spaces.workspaceId, spaces.id]
		})
	]
);

export const catalogRevisions = sqliteTable('catalog_revisions', {
	workspaceId: text('workspace_id').primaryKey().default('default'),
	revision: integer('revision').notNull().default(0)
});

// Durable operation/outbox row for the committed-catalog-write contract
// (workspace-sharding.md §4). Phase A only ever writes status:'published'
// rows, in the same transaction as the catalog row they describe — the
// pending_content/content_durable/publishable states exist in the schema now
// (avoiding a later migration) but have no producer or consumer until a real
// cross-shard operation exists (Phase B) and an SSE drain exists (Phase C).
export const catalogOutbox = sqliteTable('catalog_outbox', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	workspaceId: text('workspace_id').notNull().default('default'),
	revision: integer('revision').notNull(),
	status: text('status')
		.notNull()
		.$type<'pending_content' | 'content_durable' | 'publishable' | 'published'>(),
	operationId: text('operation_id').notNull(),
	payload: text('payload_json', { mode: 'json' }).notNull().$type<{
		documents?: string[];
		collections?: string[];
		op: 'create' | 'update' | 'move' | 'delete';
	}>(),
	createdAt: integer('created_at').notNull(),
	publishedAt: integer('published_at')
});
