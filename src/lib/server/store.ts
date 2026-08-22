import { desc, notInArray } from 'drizzle-orm';
import { getDb } from './db/index.js';
import { snapshots } from './db/schema.js';

export { getDb, closeDb } from './db/index.js';

const SNAPSHOT_RETENTION = 5;

export interface SnapshotStore {
	loadLatest(): Uint8Array | null;
	save(state: Uint8Array): void;
}

export function getSnapshotStore(): SnapshotStore {
	const db = getDb();
	return {
		loadLatest(): Uint8Array | null {
			const row = db
				.select({ state: snapshots.state })
				.from(snapshots)
				.orderBy(desc(snapshots.id))
				.limit(1)
				.get();
			return row ? new Uint8Array(row.state) : null;
		},
		save(state: Uint8Array): void {
			db.insert(snapshots)
				.values({ state: Buffer.from(state), createdAt: Date.now() })
				.run();

			const keepIds = db
				.select({ id: snapshots.id })
				.from(snapshots)
				.orderBy(desc(snapshots.id))
				.limit(SNAPSHOT_RETENTION)
				.all()
				.map((row) => row.id);

			if (keepIds.length > 0) {
				db.delete(snapshots).where(notInArray(snapshots.id, keepIds)).run();
			}
		}
	};
}
