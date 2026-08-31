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
// Same origin-based distinction audit-observer.ts already established:
// transaction.origin === null is a service-layer write (services/documents.ts
// and services/collections.ts already dual-write the catalog themselves), so
// this observer only needs to act on origin !== null (direct UI) writes.

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

// Debounced the same way audit-observer.ts debounces content edits — a title
// input fires on every keystroke, and coalescing into one catalog write per
// quiet period avoids one SQLite transaction (plus an outbox/revision bump)
// per character typed.
const UPDATE_DEBOUNCE_MS = 3_000;

// Keyed by Y.Doc instance for the same reason as audit-observer.ts: more than
// one shard's Y.Doc can be live in one process, and two shards can perfectly
// well contain an entry with the same id. workspaceId travels alongside each
// doc's timer map (not passed into flush separately) so a process-wide
// shutdown flush needs no external per-doc bookkeeping of its own.
interface PendingForDoc {
	workspaceId: string;
	timers: Map<string, ReturnType<typeof setTimeout>>;
}

const pendingByDoc = new Map<Y.Doc, PendingForDoc>();

function pendingFor(workspaceId: string, doc: Y.Doc): PendingForDoc {
	let pending = pendingByDoc.get(doc);
	if (!pending) {
		pending = { workspaceId, timers: new Map() };
		pendingByDoc.set(doc, pending);
	}
	return pending;
}

function pruneIfEmpty(doc: Y.Doc, pending: PendingForDoc): void {
	if (pending.timers.size === 0) pendingByDoc.delete(doc);
}

// JSON-encoded, not a template string — same reason as audit-observer.ts's
// timerKey: entry ids are caller-supplied with no format restriction.
function timerKey(kind: EntryKind, id: string): string {
	return JSON.stringify([kind, id]);
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

function scheduleMirror(workspaceId: string, doc: Y.Doc, kind: EntryKind, id: string): void {
	const pending = pendingFor(workspaceId, doc);
	const key = timerKey(kind, id);
	const existing = pending.timers.get(key);
	if (existing) clearTimeout(existing);
	const timer = setTimeout(() => {
		pending.timers.delete(key);
		pruneIfEmpty(doc, pending);
		mirrorNow(workspaceId, doc, kind, id);
	}, UPDATE_DEBOUNCE_MS);
	timer.unref?.();
	pending.timers.set(key, timer);
}

/** Test/shutdown hook: write any debounced mirror events immediately instead of waiting out the window, across every doc with a pending timer. */
export function flushPendingCatalogMirrorEvents(): void {
	for (const [doc, pending] of pendingByDoc) {
		for (const key of [...pending.timers.keys()]) {
			const timer = pending.timers.get(key);
			if (!timer) continue;
			clearTimeout(timer);
			pending.timers.delete(key);
			pruneIfEmpty(doc, pending);
			const [kind, id] = JSON.parse(key) as [EntryKind, string];
			mirrorNow(pending.workspaceId, doc, kind, id);
		}
	}
}

/** Test-only: drop any pending debounce timers without flushing them. */
export function resetCatalogMirrorObserverForTests(): void {
	for (const pending of pendingByDoc.values()) {
		for (const timer of pending.timers.values()) clearTimeout(timer);
	}
	pendingByDoc.clear();
}

/**
 * Attaches the generic "mirror a direct title/parentDocumentId/order edit
 * into the catalog" observer to one resolved shard's Y.Doc. Call once per
 * {workspaceId, shardId} context (workspace-store.ts's createContext(), the
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
		if (transaction.origin == null) return; // service-layer write — already mirrors itself

		const touched = new Set<string>();
		transaction.changed.forEach((_keys, type) => {
			if (maps.some((t) => t.map === type)) return; // whole-entry create/delete — not mirrored here
			const owner = resolveOwningEntry(maps, type);
			if (!owner) return;
			touched.add(timerKey(owner.kind, owner.id));
		});

		for (const key of touched) {
			const [kind, id] = JSON.parse(key) as [EntryKind, string];
			scheduleMirror(workspaceId, doc, kind, id);
		}
	});
}
