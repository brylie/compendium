import * as Y from 'yjs';
import { logAudit } from './audit.js';
import { CURRENT_USER } from './current-user.js';

// The UI edits the workspace by mutating the client's own Y.Doc directly
// (src/lib/data/records.ts, called straight from Svelte components — see
// docs/specifications/audit-coverage.md §1) and relies on y-websocket sync to
// carry that change to the server. None of those call sites go through
// src/lib/services/*.ts, so none of them call logAudit themselves — a
// content-mutating UI action would otherwise leave no audit trail at all.
//
// The fix operates one level down, on the server's own Y.Doc, rather than at
// every UI call site: y-protocols/sync applies an incoming client update via
// `Y.applyUpdate(doc, update, ws)` (see yjs-ws-server.ts), so the resulting
// transaction's `origin` is that connection's `ws` object. Every service-layer
// write, by contrast, calls `doc.transact(fn)` with no origin, which defaults
// to `null` (see yjs's own `transact(doc, f, origin = null)`). That existing,
// unmodified distinction — already true of every write path in this
// codebase — is what separates "already audited by a service function" from
// "needs this observer to audit it," with no new tagging required on any
// write path.

type EntryKind = 'document' | 'collection' | 'record';

const ACTIONS: Record<EntryKind, { create: string; update: string; delete: string }> = {
	document: { create: 'create_document', update: 'update_document', delete: 'delete_document' },
	collection: {
		create: 'create_collection',
		update: 'update_collection',
		delete: 'delete_collection'
	},
	record: { create: 'create_record', update: 'update_record', delete: 'delete_record' }
};

// Rapid-fire edits to the same record (each keystroke is its own transaction —
// see BlockEditor.svelte) would otherwise write one audit row per keystroke.
// Coalescing into one row per quiet period keeps read-event volume bounded
// (docs/specifications/audit-coverage.md §4) without losing the fact that an
// edit happened; create/delete are comparatively rare, discrete events and are
// logged immediately instead.
const UPDATE_DEBOUNCE_MS = 3_000;

// Yjs parameterizes AbstractType by the *event* type its observers receive
// (YMapEvent, YTextEvent, ...), which is what transaction.changed's keys are
// typed as; `unknown` can't stand in for that (Yjs's own event-handler types
// need the exact event shape). This alias is the one narrow escape hatch that
// lets a plain Y.Map and a Y.Text compare and walk `.parent` interchangeably
// below — only ever for identity comparisons, never the event payload itself.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyYType = Y.AbstractType<any>;

interface TopLevelMap {
	kind: EntryKind;
	map: AnyYType;
}

function topLevelMaps(doc: Y.Doc): TopLevelMap[] {
	return [
		{ kind: 'document', map: doc.getMap('documents') },
		{ kind: 'collection', map: doc.getMap('collections') },
		{ kind: 'record', map: doc.getMap('records') }
	];
}

/**
 * Walks a changed Yjs type up through its ancestors to find which top-level
 * entry (a Document, Collection, or record) owns it — e.g. a record's
 * `content` Y.Text's parent is that record's own Y.Map, whose parent is the
 * top-level `records` Y.Map. Returns undefined for a type that isn't (yet, or
 * anymore) reachable from one of the three top-level maps, e.g. a type that
 * was part of an entry deleted earlier in the same transaction.
 */
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

// Keyed by Y.Doc instance, not just `${kind}:${id}`: workspace-store.ts can
// resolve more than one Y.Doc in the same process (one per workspace/shard
// context), and two different workspaces' documents can perfectly well both
// contain a record with the same id. A single flat `${kind}:${id}` → timer
// map would let a debounced update on one workspace's doc clobber another's
// in-flight timer for the "same" key, silently dropping an audit event.
const pendingUpdateTimers = new Map<Y.Doc, Map<string, ReturnType<typeof setTimeout>>>();

function timersFor(doc: Y.Doc): Map<string, ReturnType<typeof setTimeout>> {
	let timers = pendingUpdateTimers.get(doc);
	if (!timers) {
		timers = new Map();
		pendingUpdateTimers.set(doc, timers);
	}
	return timers;
}

// JSON-encoded rather than a `${kind}:${id}` template string: entry ids are
// caller-supplied with no format restriction (e.g. the MCP server's
// recordId: z.string() — see createRecord's `input.id`), so an id containing
// ':' would otherwise make flushPendingAuditEvents' key.split(':') below
// silently truncate it back to the wrong id.
function timerKey(kind: EntryKind, id: string): string {
	return JSON.stringify([kind, id]);
}

/** Removes doc's entry from the outer map once its last timer is gone, so a released Y.Doc isn't kept alive by a stale empty inner Map. */
function pruneIfEmpty(doc: Y.Doc, timers: Map<string, ReturnType<typeof setTimeout>>): void {
	if (timers.size === 0) pendingUpdateTimers.delete(doc);
}

function scheduleUpdateAudit(doc: Y.Doc, kind: EntryKind, id: string): void {
	const timers = timersFor(doc);
	const key = timerKey(kind, id);
	const existing = timers.get(key);
	if (existing) clearTimeout(existing);
	const timer = setTimeout(() => {
		timers.delete(key);
		pruneIfEmpty(doc, timers);
		logAudit({ actor: CURRENT_USER, action: ACTIONS[kind].update, targetRecordId: id });
	}, UPDATE_DEBOUNCE_MS);
	timer.unref?.();
	timers.set(key, timer);
}

/**
 * Writes a single pending debounced update immediately, if one is armed for
 * this entry. Called before logging a create/delete for the same (kind, id)
 * so an edit that happened moments before a delete — still sitting in the
 * debounce window — is written in the order it actually happened, instead of
 * surfacing later as an `update_*` row that appears *after* the `delete_*`
 * row for the same, now-gone target.
 */
function flushPendingFor(doc: Y.Doc, kind: EntryKind, id: string): void {
	const timers = pendingUpdateTimers.get(doc);
	if (!timers) return;
	const key = timerKey(kind, id);
	const timer = timers.get(key);
	if (!timer) return;
	clearTimeout(timer);
	timers.delete(key);
	pruneIfEmpty(doc, timers);
	logAudit({ actor: CURRENT_USER, action: ACTIONS[kind].update, targetRecordId: id });
}

/** Test/shutdown hook: write any debounced update events immediately instead of waiting out the window, across every doc with a pending timer. */
export function flushPendingAuditEvents(): void {
	for (const [doc, timers] of pendingUpdateTimers) {
		for (const key of [...timers.keys()]) {
			const [kind, id] = JSON.parse(key) as [EntryKind, string];
			flushPendingFor(doc, kind, id);
		}
	}
}

/** Test-only: number of Y.Docs currently holding at least one pending timer — proves a doc with no pending timers left is pruned, not retained. */
export function pendingTimerDocCountForTests(): number {
	return pendingUpdateTimers.size;
}

/** Test-only: drop any pending debounce timers without flushing them. */
export function resetAuditObserverForTests(): void {
	for (const timers of pendingUpdateTimers.values()) {
		for (const timer of timers.values()) clearTimeout(timer);
	}
	pendingUpdateTimers.clear();
}

type FinalizedEntry = { kind: EntryKind; id: string; action: string };

// Pass 1: whole entries created/deleted at a top-level map — a changed key
// on the map itself always means "entry added" or "entry removed" (nothing
// in this codebase reassigns an existing top-level key). Mutates `finalized`
// in place rather than returning a new map, so both passes accumulate into
// the one map attachDocAuditObserver's transaction handler owns.
function collectTopLevelEntryChanges(
	transaction: Y.Transaction,
	maps: TopLevelMap[],
	finalized: Map<string, FinalizedEntry>
): void {
	for (const { kind, map } of maps) {
		const keys = transaction.changed.get(map);
		if (!keys) continue;
		for (const key of keys) {
			if (key == null) continue;
			const action = (map as Y.Map<unknown>).has(key) ? ACTIONS[kind].create : ACTIONS[kind].delete;
			finalized.set(`${kind}:${key}`, { kind, id: key, action });
		}
	}
}

// Pass 2: field/content/order changes nested within an existing entry.
function collectNestedEntryChanges(
	transaction: Y.Transaction,
	maps: TopLevelMap[],
	finalized: Map<string, FinalizedEntry>
): void {
	transaction.changed.forEach((_keys, type) => {
		if (maps.some((t) => t.map === type)) return; // handled in pass 1
		const owner = resolveOwningEntry(maps, type);
		if (!owner) return;
		const dedupeKey = `${owner.kind}:${owner.id}`;
		if (finalized.has(dedupeKey)) return; // already create/delete this transaction
		finalized.set(dedupeKey, {
			kind: owner.kind,
			id: owner.id,
			action: ACTIONS[owner.kind].update
		});
	});
}

function flushFinalizedEntries(doc: Y.Doc, finalized: Map<string, FinalizedEntry>): void {
	for (const { kind, id, action } of finalized.values()) {
		if (action === ACTIONS[kind].update) {
			scheduleUpdateAudit(doc, kind, id);
		} else {
			// A create/delete resolves any edit still sitting in the debounce
			// window for this same entry first, so it's written in the order it
			// actually happened rather than surfacing later, after the entry is
			// already gone.
			flushPendingFor(doc, kind, id);
			logAudit({ actor: CURRENT_USER, action, targetRecordId: id });
		}
	}
}

/**
 * Attaches the generic "audit whatever the UI just did" observer to the
 * server's Y.Doc. Call once per Y.Doc instance (workspace-store.ts's
 * createContext() does this after loading its initial snapshot, so the
 * snapshot's own applyUpdate — which
 * runs before this is attached — never triggers a spurious audit trail on
 * process start).
 */
export function attachDocAuditObserver(doc: Y.Doc): void {
	const maps = topLevelMaps(doc);

	doc.on('afterTransaction', (transaction: Y.Transaction) => {
		if (transaction.origin == null) return; // service-layer write — already audited itself

		const finalized = new Map<string, FinalizedEntry>();
		collectTopLevelEntryChanges(transaction, maps, finalized);
		collectNestedEntryChanges(transaction, maps, finalized);
		flushFinalizedEntries(doc, finalized);
	});
}
