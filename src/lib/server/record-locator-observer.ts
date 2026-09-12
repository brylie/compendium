import * as Y from 'yjs';
import { reserveRecordLocator, resolveShardForRecord } from './catalog.js';
import { mutationSource, UnknownMutationOriginError } from '../mutation-origin.js';

// The service layer's own createRecord (services/records.ts) reserves a
// record locator itself before writing, so write_record/delete_record/
// hold_records can later resolve which shard a bare recordId lives in. A
// direct UI creation (record-ops.ts's createRecord, called straight from the
// block editor with no service call — see
// docs/specifications/audit-coverage.md §1) never reserves one on its own.
// Once a Document has its own real shard (#120), that gap means such a
// record is invisible to resolveShardForRecord, which falls back to the
// *default* shard — every MCP tool keyed by bare recordId then 404s a
// record that genuinely exists, just in the wrong resolved doc (issue #253).
//
// This observer closes the gap generically, the same way catalog-mirror-
// observer.ts closes its own equivalent gap for direct UI mutations: react
// to the raw Y.Doc transaction instead of requiring every UI call site to
// remember a server round trip. Service-origin transactions are excluded,
// not just redundant: services/records.ts's own createRecord reserves a
// container's *descendant* locators (reserveDescendantLocators) only after
// its whole transactWithOrigin(doc, SERVICE_ORIGIN, ...) call returns, but
// Yjs fires afterTransaction synchronously *during* that call — reacting to
// service-origin transactions here would race ahead and reserve the
// descendant's locator first, so the service's own reservation call then
// throws RecordIdConflictError instead of the no-op it should be.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyYType = Y.AbstractType<any>;

/**
 * Attaches the "reserve a locator for every record created in this shard"
 * observer to one resolved shard's Y.Doc. Call once per Y.Doc instance
 * (workspace-store.ts's createContext(), alongside backfillRecordLocators
 * for content that predates this observer).
 */
export function attachRecordLocatorObserver(
	workspaceId: string,
	spaceId: string,
	shardId: string,
	doc: Y.Doc
): void {
	const recordsTop: AnyYType = doc.getMap('records');
	const recordsMap = recordsTop as Y.Map<unknown>;

	doc.on('afterTransaction', (transaction: Y.Transaction) => {
		const source = mutationSource(transaction.origin);
		if (!source) throw new UnknownMutationOriginError(transaction.origin);
		if (
			source !== 'local-ui' &&
			source !== 'remote-ui' &&
			source !== 'undo-redo' &&
			source !== 'test'
		)
			return;

		const topKeys = transaction.changed.get(recordsTop);
		if (!topKeys) return;

		for (const key of topKeys) {
			if (key == null) continue;
			if (!recordsMap.has(key)) continue; // a deletion, not a creation
			if (resolveShardForRecord(workspaceId, key)) continue; // already reserved
			reserveRecordLocator(workspaceId, spaceId, key, shardId);
		}
	});
}
