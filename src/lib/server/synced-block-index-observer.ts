import * as Y from 'yjs';
import {
	deleteSyncedBlockInstanceEntry,
	upsertSyncedBlockInstanceEntry
} from './synced-block-index.js';
import { resolveRecordId } from './record-index-observer.js';
import { mutationSource, UnknownMutationOriginError } from '../mutation-origin.js';

// Keeps db/schema.ts's synced_block_instance projection live for one resolved
// shard's Y.Doc — the synced-block-specific analogue of record-index-observer.ts,
// reusing its resolveRecordId walk (a Y.Text/attribute edit's changed type isn't
// itself a `records` map key; this walks up to the record that owns it). Like
// record_index, no write path (setRecordReferencedId is shared by page_link/
// collection_view/synced_block alike, and record-ops.ts's direct-Yjs callers
// never touch this table themselves) updates synced_block_instance on its own,
// so this reacts to every mutation source, not just the ones the service layer
// doesn't already cover.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyYType = Y.AbstractType<any>;

/** Test-only compatibility hook, mirroring record-index-observer.ts's — projections here are synchronous, so there's nothing to flush. */
export function resetSyncedBlockIndexObserverForTests(): void {
	// No-op by design.
}

/**
 * Attaches the "keep synced_block_instance in sync with this shard's records"
 * observer to one resolved shard's Y.Doc. Call once per Y.Doc instance
 * (workspace-store.ts's createContext(), right after
 * rebuildSyncedBlockIndexForShard has given it a correct starting point).
 */
export function attachSyncedBlockIndexObserver(
	workspaceId: string,
	shardId: string,
	doc: Y.Doc
): void {
	const recordsTop: AnyYType = doc.getMap('records');
	const recordsMap = recordsTop as Y.Map<unknown>;

	doc.on('afterTransaction', (transaction: Y.Transaction) => {
		const source = mutationSource(transaction.origin);
		if (!source) throw new UnknownMutationOriginError(transaction.origin);

		const touched = new Set<string>();

		const topKeys = transaction.changed.get(recordsTop);
		if (topKeys) {
			for (const key of topKeys) {
				if (key != null) touched.add(key);
			}
		}

		transaction.changed.forEach((_keys, type) => {
			if (type === recordsTop) return; // whole-record create/delete — handled above
			const id = resolveRecordId(recordsTop, type);
			if (id) touched.add(id);
		});

		for (const id of touched) {
			if (recordsMap.has(id)) {
				upsertSyncedBlockInstanceEntry(workspaceId, shardId, doc, id);
			} else {
				deleteSyncedBlockInstanceEntry(workspaceId, id);
			}
		}
	});
}
