import * as Y from 'yjs';

// Local, per-actor undo/redo (#8): each browser tab tracks only its own
// locally-originated Yjs transactions, never a collaborator's — including a
// stateless MCP agent's writes, which is exactly the "never a collaborator's
// intervening work" guarantee the issue asks for.
//
// This falls out of Y.UndoManager's own default `trackedOrigins: new
// Set([null])` combined with how every local write already runs through an
// untagged `doc.transact(...)` call (or a single untransacted `.set()`,
// which Yjs auto-wraps the same way) in src/lib/data/records.ts and the
// block editor — Yjs assigns those the `null` origin. Remote edits, whether
// from a collaborator's browser tab or an MCP agent, always arrive over this
// tab's y-websocket connection and are applied by y-protocols' sync handler
// with the WebsocketProvider instance itself as the transaction origin (see
// y-websocket's `readSyncMessage` call), which is never `null` and so is
// never tracked. No extra origin-tagging is needed on either side for that
// separation to hold — it's a byproduct of the existing transact() calls,
// not a new convention call sites need to opt into.
const SCOPE_MAP_NAMES = ['documents', 'collections', 'records'] as const;

/**
 * A fresh UndoManager scoped to every place a local edit can land: the
 * Documents index (titles, hierarchy, and each Document's block-order
 * array), the Collections index (schema and each Collection's row-order
 * array), and Records (block/row content, properties, and structural
 * fields). Passing these three top-level maps covers their nested Y.Text/
 * Y.Array/Y.Map content too — Y.UndoManager tracks a transaction if any
 * type it touched has one of the scope types as an ancestor, not just the
 * scope types themselves.
 */
export function createUndoManager(doc: Y.Doc): Y.UndoManager {
	return new Y.UndoManager(SCOPE_MAP_NAMES.map((name) => doc.getMap(name)));
}

// Keyed by Y.Doc instance, not a single module-level singleton: each
// Document now has its own shard (#120), so the manager must be re-created
// per open Document rather than staying bound to one process-wide doc —
// this is the "revisit" undo-redo.md §4 already flagged once Documents
// stopped sharing a single workspace Y.Doc. Cached per doc (not recreated on
// every call) so switching back to a previously-open Document's tab-local
// history doesn't lose it, matching a real editor's per-document undo stack.
const managers = new Map<Y.Doc, Y.UndoManager>();

function getManager(doc: Y.Doc): Y.UndoManager {
	let manager = managers.get(doc);
	if (!manager) {
		manager = createUndoManager(doc);
		managers.set(doc, manager);
	}
	return manager;
}

/** Undoes the most recent locally-originated edit on `doc`, using (and lazily creating) that doc's own per-document undo stack. */
export function undo(doc: Y.Doc): void {
	getManager(doc).undo();
}

/** Redoes the most recently undone locally-originated edit on `doc`, using (and lazily creating) that doc's own per-document undo stack. */
export function redo(doc: Y.Doc): void {
	getManager(doc).redo();
}

export interface UndoRedoState {
	canUndo: boolean;
	canRedo: boolean;
}

function readState(um: Y.UndoManager): UndoRedoState {
	return { canUndo: um.undoStack.length > 0, canRedo: um.redoStack.length > 0 };
}

/** Reactive canUndo/canRedo for `doc`, for driving the toolbar's disabled state — re-subscribe when the open Document (and therefore its shard doc) changes. */
export function subscribeUndoRedoState(
	doc: Y.Doc,
	onChange: (state: UndoRedoState) => void
): () => void {
	const um = getManager(doc);
	const compute = () => onChange(readState(um));
	um.on('stack-item-added', compute);
	um.on('stack-item-popped', compute);
	um.on('stack-item-updated', compute);
	compute();
	return () => {
		um.off('stack-item-added', compute);
		um.off('stack-item-popped', compute);
		um.off('stack-item-updated', compute);
	};
}
