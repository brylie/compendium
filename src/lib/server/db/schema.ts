import { blob, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
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
