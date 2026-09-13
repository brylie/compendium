import { and, eq, inArray } from 'drizzle-orm';
import type * as Y from 'yjs';
import { getDb } from './store.js';
import { syncedBlockInstance } from './db/schema.js';
import { getRecord, listAllRecordIds } from '../data/record-ops.js';

// #242's durable "used in N places" reverse index — see db/schema.ts's own
// doc comment for why listIncomingLinks/listSyncedBlockInstances
// (src/lib/data/links.ts) can't answer this cross-shard on their own. This
// module is the record_index.ts analogue for this one narrower projection:
// same rebuild-wholesale-per-shard-load + upsert-on-touched-record shape,
// differing mainly in storage (an exact-match Drizzle table, not FTS5 — this
// index is never full-text matched).

/** Removes any existing row for `instanceRecordId` — the synced_block no longer exists, or no longer references anything. */
export function deleteSyncedBlockInstanceEntry(
	workspaceId: string,
	instanceRecordId: string
): void {
	getDb()
		.delete(syncedBlockInstance)
		.where(
			and(
				eq(syncedBlockInstance.workspaceId, workspaceId),
				eq(syncedBlockInstance.instanceRecordId, instanceRecordId)
			)
		)
		.run();
}

/**
 * Recomputes and writes `recordId`'s row from its current authoritative
 * `Y.Doc` state — called on every create/update reaching that record (see
 * synced-block-index-observer.ts). Clears any stale row when the record no
 * longer exists, is no longer a `synced_block`, or no longer has a
 * `referencedRecordId` set.
 */
export function upsertSyncedBlockInstanceEntry(
	workspaceId: string,
	shardId: string,
	doc: Y.Doc,
	recordId: string
): void {
	const record = getRecord(doc, recordId);
	if (record?.blockType !== 'synced_block' || !record?.referencedRecordId) {
		deleteSyncedBlockInstanceEntry(workspaceId, recordId);
		return;
	}

	getDb().transaction((tx) => {
		tx.delete(syncedBlockInstance)
			.where(
				and(
					eq(syncedBlockInstance.workspaceId, workspaceId),
					eq(syncedBlockInstance.instanceRecordId, recordId)
				)
			)
			.run();
		tx.insert(syncedBlockInstance)
			.values({
				workspaceId,
				sourceRecordId: record.referencedRecordId!,
				instanceRecordId: recordId,
				instanceShardId: shardId,
				createdAt: Date.now()
			})
			.run();
	});
}

/**
 * Wipes and rebuilds every synced_block_instance row for one shard from its
 * just-loaded `Y.Doc` — run once per shard context load (workspace-store.ts's
 * createContext(), right before attachSyncedBlockIndexObserver takes over
 * keeping it live), the same "rebuildable by replaying the Y.Doc's current
 * state" contract record-index.ts's rebuildRecordIndexForShard follows.
 */
export function rebuildSyncedBlockIndexForShard(
	workspaceId: string,
	shardId: string,
	doc: Y.Doc
): void {
	getDb()
		.delete(syncedBlockInstance)
		.where(
			and(
				eq(syncedBlockInstance.workspaceId, workspaceId),
				eq(syncedBlockInstance.instanceShardId, shardId)
			)
		)
		.run();
	for (const recordId of listAllRecordIds(doc)) {
		upsertSyncedBlockInstanceEntry(workspaceId, shardId, doc, recordId);
	}
}

export interface SyncedBlockInstanceRow {
	sourceRecordId: string;
	instanceRecordId: string;
	instanceShardId: string;
}

/**
 * Every synced_block instance (workspace-wide, any shard) currently
 * referencing one of `sourceRecordIds` — the reverse-index read this table
 * exists for. Returns raw locator rows (no permission/title resolution);
 * services/synced-blocks.ts resolves each hit's owning Document/context
 * against its actual shard.
 */
export function listSyncedBlockInstancesAcrossShards(
	workspaceId: string,
	sourceRecordIds: string[]
): SyncedBlockInstanceRow[] {
	if (sourceRecordIds.length === 0) return [];
	return getDb()
		.select({
			sourceRecordId: syncedBlockInstance.sourceRecordId,
			instanceRecordId: syncedBlockInstance.instanceRecordId,
			instanceShardId: syncedBlockInstance.instanceShardId
		})
		.from(syncedBlockInstance)
		.where(
			and(
				eq(syncedBlockInstance.workspaceId, workspaceId),
				inArray(syncedBlockInstance.sourceRecordId, sourceRecordIds)
			)
		)
		.all();
}
