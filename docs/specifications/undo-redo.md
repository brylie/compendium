# Undo/redo — local, per-actor

**Depends on:** [`data-model.md`](./data-model.md) §4 (Yjs mapping), [`collaboration.md`](./collaboration.md) (why remote writes never share this tab's transaction origin)

---

## 1. Scope: what "local, per-actor" means

Each browser tab tracks only its own locally-originated Yjs transactions — never a collaborator's intervening work, and never a stateless MCP agent's writes (agent-side after-the-fact recovery is a separate, deliberately different problem: record history/restore, tracked as its own item on the roadmap, not this one). Undo/redo is not synced or shared between tabs or actors; it is purely local UI state layered on top of the shared `Y.Doc`.

## 2. Mechanism: Y.UndoManager, scoped to the whole local write surface

`src/lib/client/undo.ts` constructs one [`Y.UndoManager`](https://docs.yjs.dev/api/undo-manager) per client `Y.Doc`, scoped to the three top-level shared types every local write lands in: the Documents index, the Collections index, and Records (`doc.getMap('documents' | 'collections' | 'records')`). Y.UndoManager tracks a transaction if any type it touched has one of the scope types as an ancestor, not just the scope types themselves — so this also covers every block's nested `Y.Text` content, every record's properties, and each parent's block/row-order array, without needing a separate UndoManager per block.

**Why this requires no new origin-tagging convention:** Y.UndoManager's own default `trackedOrigins` is `new Set([null])` — it only tracks transactions whose origin is `null`. Every local write already goes through an untagged `doc.transact(...)` call (or a single untransacted `.set()`, which Yjs auto-wraps the same way) in `src/lib/data/records.ts` and the block editor, and Yjs assigns those the `null` origin by default. Remote edits — from a collaborator's browser tab or an MCP agent — always arrive over this tab's y-websocket connection and are applied by y-protocols' sync handler with the `WebsocketProvider` instance itself as the transaction origin (see y-websocket's `readSyncMessage` call), which is never `null` and so is never tracked. The local/remote split that "local, per-actor" requires falls directly out of the existing transport architecture (`architecture.md` §1) — no call site needs to opt in.

## 3. Grouping and correctness under concurrent edits

- **Grouping:** Y.UndoManager's default `captureTimeout` (500ms) merges same-origin transactions that land close together into a single undo step — the standard "undo the whole typing burst, not one keystroke at a time" behavior every native text editor has.
- **Never reverts another actor's transaction:** because only `null`-origin (local) transactions are tracked, undo can only ever pop a stack item built from this tab's own writes. A concurrent remote transaction is invisible to the undo/redo stacks regardless of timing.
- **Redo restores exactly the reverted action, even after an intervening remote edit:** Y.UndoManager keeps deleted-but-undoable items alive (`keepItem`) rather than letting them get garbage collected, and its redo path re-derives the current position of restored content structurally rather than replaying a fixed diff — so a remote edit to unrelated content between an undo and its redo doesn't corrupt either operation.
- **Never overwrites a remote edit to the same key:** Y.UndoManager's default (`ignoreRemoteMapChanges: false`) skips restoring a Y.Map key's prior value on undo if a remote actor changed that same key afterward, rather than silently clobbering it.

All four properties are exercised directly against real `Y.Doc` pairs (a local doc and a simulated remote peer, merged via `Y.applyUpdate`) in [`src/lib/client/undo.test.ts`](../../src/lib/client/undo.test.ts) — including the two hardest cases the feature has to prove: undo never touching a concurrently-created remote block, and redo restoring the exact local action after a remote edit lands in between.

## 4. UI surface

- **Shortcuts:** Cmd/Ctrl+Z (undo) and Cmd/Ctrl+Shift+Z (redo), bound at the document level in `/doc/[id]` (`+page.svelte`) rather than scoped to a single block — the action being undone might not be the block currently focused (e.g. undoing a delete brings back a block with nothing yet to focus).
- **Toolbar affordance:** Undo/Redo buttons in the persistent document toolbar (`Toolbar.svelte`), disabled when their respective stack is empty, reflecting `subscribeUndoRedoState`'s reactive `{ canUndo, canRedo }`.
- The UndoManager instance is created lazily on first use and is bound to whichever `Y.Doc` `getClientDoc()` currently returns; `+page.svelte` forces it into existence on mount (before any local edit can happen), since Y.UndoManager only tracks transactions made after it's constructed.
