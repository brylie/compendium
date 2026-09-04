import * as Y from 'yjs';
import {
	getCollection as crdtGetCollection,
	getDocument as crdtGetDocument
} from '../data/records.js';
import {
	recordCatalogCollectionTitleChanged,
	recordCatalogDocumentMoved,
	recordCatalogDocumentTitleChanged
} from './catalog.js';
import { mutationSource, UnknownMutationOriginError } from '../mutation-origin.js';

// A direct UI mutation (the title input on /doc/[id] or /table/[id], or a
// future Sidebar drag-and-drop reorder) writes straight to its own shard's
// Y.Doc, the same as any other UI edit (see audit-coverage.md §1) — but the
// catalog is the only place a *different* shard's Sidebar/picker/backlink
// lookup can ever see a title or parentDocumentId (workspace-sharding.md
// §3.2: "a content shard does not own its title, parent hierarchy"). Without
// this observer, a direct rename never reaches the catalog, so it never
// becomes visible anywhere outside the page that made it — not even after a
// refresh, since the catalog itself was never updated.
//
// Services have their own authoritative catalog write in the same operation.
// This observer owns the corresponding projection for direct UI transactions.

type EntryKind = 'document' | 'collection';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyYType = Y.AbstractType<any>;

interface TopLevelMap {
	kind: EntryKind;
	map: AnyYType;
}

function topLevelMaps(doc: Y.Doc): TopLevelMap[] {
	return [
		{ kind: 'document', map: doc.getMap('documents') },
		{ kind: 'collection', map: doc.getMap('collections') }
	];
}

/** Same walk-up-to-owning-entry logic as audit-observer.ts's resolveOwningEntry, scoped to just documents/collections (records never need catalog mirroring). */
function resolveOwningEntry(
	maps: TopLevelMap[],
	type: AnyYType
): { kind: EntryKind; id: string } | undefined {
	let current: AnyYType | null = type;
	while (current) {
		const parent: AnyYType | null = current.parent;
		if (!parent) return undefined;
		const top = maps.find((t) => t.map === parent);
		if (top) {
			let foundId: string | undefined;
			(parent as Y.Map<unknown>).forEach((value, key) => {
				if (value === current) foundId = key;
			});
			return foundId ? { kind: top.kind, id: foundId } : undefined;
		}
		current = parent;
	}
	return undefined;
}

function mirrorNow(workspaceId: string, doc: Y.Doc, kind: EntryKind, id: string): void {
	if (kind === 'document') {
		const meta = crdtGetDocument(doc, id);
		if (!meta) return; // deleted since this was scheduled — nothing to mirror
		recordCatalogDocumentTitleChanged(workspaceId, id, meta.title);
		recordCatalogDocumentMoved(workspaceId, id, meta.parentDocumentId, meta.order);
	} else {
		const meta = crdtGetCollection(doc, id);
		if (!meta) return;
		recordCatalogCollectionTitleChanged(workspaceId, id, meta.title);
	}
}

/**
 * Kept as a shutdown compatibility hook. Catalog projections are synchronous,
 * so there is deliberately no in-memory queue left to flush.
 */
export function flushPendingCatalogMirrorEvents(): void {
	// No-op by design.
}

/** Test-only compatibility hook. */
export function resetCatalogMirrorObserverForTests(): void {
	// No-op by design.
}

/**
 * Attaches the generic "mirror a direct title/parentDocumentId/order edit
 * into the catalog" observer to one resolved shard's Y.Doc. Call once per
 * workspaceId/shardId context (workspace-store.ts's createContext(), the
 * same call site attachDocAuditObserver already uses) — deletion is
 * deliberately not handled here; it's already correctly cascaded by routing
 * through the service layer's own recordCatalog*Deleted call (see
 * services/documents.ts, services/collections.ts), and creation already goes
 * through the service layer too (audit-coverage.md §1), so this observer
 * only ever needs to react to an existing entry's fields changing.
 */
export function attachCatalogMirrorObserver(workspaceId: string, doc: Y.Doc): void {
	const maps = topLevelMaps(doc);

	doc.on('afterTransaction', (transaction: Y.Transaction) => {
		const source = mutationSource(transaction.origin);
		if (!source) throw new UnknownMutationOriginError(transaction.origin);
		if (source !== 'local-ui' && source !== 'remote-ui' && source !== 'test') return;

		const touched = new Map<string, { kind: EntryKind; id: string }>();
		transaction.changed.forEach((_keys, type) => {
			if (maps.some((t) => t.map === type)) return; // whole-entry create/delete — not mirrored here
			const owner = resolveOwningEntry(maps, type);
			if (!owner) return;
			touched.set(JSON.stringify([owner.kind, owner.id]), owner);
		});

		for (const { kind, id } of touched.values()) mirrorNow(workspaceId, doc, kind, id);
	});
}
