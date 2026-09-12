import * as Y from 'yjs';
import { deleteRecordIndexEntry, upsertRecordIndexEntry } from './record-index.js';
import { mutationSource, UnknownMutationOriginError } from '../mutation-origin.js';

// Keeps persistence.md §2's record_index projection live for one resolved
// shard's Y.Doc, the record-level analogue of catalog-mirror-observer.ts.
// Unlike the catalog (which the service layer already dual-writes on every
// create/move/delete, see catalog.ts) or audit (which the service layer
// already logs for itself, see audit-observer.ts's doc comment), no write
// path updates record_index on its own — this observer reacts to every
// mutation source (service, direct UI, migration, undo-redo, test), not
// just the ones the service layer doesn't already cover itself.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyYType = Y.AbstractType<any>;

/**
 * Walks a changed Yjs type up through its ancestors to find which record id
 * (a key of the top-level `records` map) owns it — e.g. a record's `content`
 * Y.Text's parent is that record's own Y.Map, whose parent is `recordsTop`.
 * Returns undefined for a type that isn't (yet, or anymore) reachable from
 * `recordsTop`, e.g. part of a record deleted earlier in the same
 * transaction.
 */
function resolveRecordId(recordsTop: AnyYType, type: AnyYType): string | undefined {
	let current: AnyYType | null = type;
	while (current) {
		const parent: AnyYType | null = current.parent;
		if (!parent) return undefined;
		if (parent === recordsTop) {
			let foundId: string | undefined;
			(parent as Y.Map<unknown>).forEach((value, key) => {
				if (value === current) foundId = key;
			});
			return foundId;
		}
		current = parent;
	}
	return undefined;
}

/** Test-only compatibility hook, mirroring catalog-mirror-observer.ts's — projections here are synchronous, so there's nothing to flush. */
export function resetRecordIndexObserverForTests(): void {
	// No-op by design.
}

/**
 * Attaches the "keep record_index in sync with this shard's records" observer
 * to one resolved shard's Y.Doc. Call once per Y.Doc instance
 * (workspace-store.ts's createContext(), right after
 * rebuildRecordIndexForShard has given it a correct starting point).
 */
export function attachRecordIndexObserver(workspaceId: string, shardId: string, doc: Y.Doc): void {
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
				upsertRecordIndexEntry(workspaceId, shardId, doc, id);
			} else {
				deleteRecordIndexEntry(id);
			}
		}
	});
}
