import { and, desc, eq, notInArray } from 'drizzle-orm';
import { getDb } from './db/index.js';
import { snapshots } from './db/schema.js';

export { getDb, closeDb } from './db/index.js';

const SNAPSHOT_RETENTION = 5;

export interface SnapshotStore {
	loadLatest(): Uint8Array | null;
	save(state: Uint8Array): void;
}

/**
 * Snapshots are keyed by (workspaceId, shardId) so distinct workspace
 * contexts never share, overwrite, or prune each other's persisted state —
 * even though Phase 0 only ever resolves the one default key in practice
 * (see workspace-store.ts). The retention delete is scoped by the same key
 * for the same reason: an unscoped `notInArray` would prune every other
 * workspace's history down to whatever this call's own keepIds happened to be.
 */
export function getSnapshotStore(workspaceId: string, shardId: string): SnapshotStore {
	const db = getDb();
	const keyFilter = and(eq(snapshots.workspaceId, workspaceId), eq(snapshots.shardId, shardId));

	return {
		loadLatest(): Uint8Array | null {
			const row = db
				.select({ state: snapshots.state })
				.from(snapshots)
				.where(keyFilter)
				.orderBy(desc(snapshots.id))
				.limit(1)
				.get();
			return row ? new Uint8Array(row.state) : null;
		},
		save(state: Uint8Array): void {
			db.insert(snapshots)
				.values({ workspaceId, shardId, state: Buffer.from(state), createdAt: Date.now() })
				.run();

			const keepIds = db
				.select({ id: snapshots.id })
				.from(snapshots)
				.where(keyFilter)
				.orderBy(desc(snapshots.id))
				.limit(SNAPSHOT_RETENTION)
				.all()
				.map((row) => row.id);

			if (keepIds.length > 0) {
				db.delete(snapshots)
					.where(and(keyFilter, notInArray(snapshots.id, keepIds)))
					.run();
			}
		}
	};
}
