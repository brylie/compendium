# Undo/redo — local, per-actor

**Depends on:** [`data-model.md`](./data-model.md) §4 (Yjs mapping), [`collaboration.md`](./collaboration.md) (why remote writes never share this tab's transaction origin)

---

## 1. Scope: what "local, per-actor" means

Each browser tab tracks only its own locally-originated Yjs transactions — never a collaborator's intervening work, and never a stateless MCP agent's writes (agent-side after-the-fact recovery is a separate, deliberately different problem: record history/restore, tracked as its own item on the roadmap, not this one). Undo/redo is not synced or shared between tabs or actors; it is purely local UI state layered on top of the shared `Y.Doc`.

## 2. Mechanism: Y.UndoManager, scoped to one Document shard's local write surface

`src/lib/client/undo.ts` constructs one [`Y.UndoManager`](https://docs.yjs.dev/api/undo-manager) per `Y.Doc` (see §5: since #120, that's per-Document-shard, not a single workspace-wide doc), scoped to the three top-level shared types every local write lands in: the Documents index, the Collections index, and Records (`doc.getMap('documents' | 'collections' | 'records')`). Y.UndoManager tracks a transaction if any type it touched has one of the scope types as an ancestor, not just the scope types themselves — so this also covers every block's nested `Y.Text` content, every record's properties, and each parent's block/row-order array, without needing a separate UndoManager per block.

**Explicit origin contract:** `Y.UndoManager` tracks only `LOCAL_UI_ORIGIN`. Remote UI, service/MCP, migration, replay, and test transactions use distinct named origins from `mutation-origin.ts`; undo/redo transactions are registered as `undo-redo`. No production behavior infers actor class from `null` or an object identity.

## 3. Grouping and correctness under concurrent edits

- **Grouping:** Y.UndoManager's default `captureTimeout` (500ms) merges same-origin transactions that land close together into a single undo step — the standard "undo the whole typing burst, not one keystroke at a time" behavior every native text editor has.
- **Never reverts another actor's transaction:** because only `null`-origin (local) transactions are tracked, undo can only ever pop a stack item built from this tab's own writes. A concurrent remote transaction is invisible to the undo/redo stacks regardless of timing.
- **Redo restores exactly the reverted action, even after an intervening remote edit:** Y.UndoManager keeps deleted-but-undoable items alive (`keepItem`) rather than letting them get garbage collected, and its redo path re-derives the current position of restored content structurally rather than replaying a fixed diff — so a remote edit to unrelated content between an undo and its redo doesn't corrupt either operation.
- **Never overwrites a remote edit to the same key:** Y.UndoManager's default (`ignoreRemoteMapChanges: false`) skips restoring a Y.Map key's prior value on undo if a remote actor changed that same key afterward, rather than silently clobbering it.

All four properties are exercised directly against real `Y.Doc` pairs (a local doc and a simulated remote peer, merged via `Y.applyUpdate`) in [`src/lib/client/undo.test.ts`](../../src/lib/client/undo.test.ts) — including the two hardest cases the feature has to prove: undo never touching a concurrently-created remote block, and redo restoring the exact local action after a remote edit lands in between.

## 4. UI surface

- **Shortcuts:** Cmd/Ctrl+Z (undo) and Cmd/Ctrl+Shift+Z or Ctrl+Y (redo — the latter is the Windows/Linux convention, kept alongside Cmd/Ctrl+Shift+Z rather than instead of it), bound at the document level in `/doc/[id]` (`+page.svelte`) rather than scoped to a single block — the action being undone might not be the block currently focused (e.g. undoing a delete brings back a block with nothing yet to focus).
- **Toolbar affordance:** Undo/Redo buttons in the persistent document toolbar (`Toolbar.svelte`), disabled when their respective stack is empty, reflecting `subscribeUndoRedoState`'s reactive `{ canUndo, canRedo }`. Tooltips show both the `⌘` and `Ctrl` forms together (`⌘/Ctrl+Z`), matching the footer hint's existing convention (`+page.svelte`'s formatting-shortcuts footer) rather than detecting the platform at runtime.
- The UndoManager instance is created lazily per `doc` (`undo.ts`'s `getManager(doc)`, cached in a `Map<Y.Doc, Y.UndoManager>` so switching back to a previously-open Document doesn't lose its tab-local history) and `+page.svelte` forces it into existence — via `subscribeUndoRedoState(doc, ...)` — as soon as the currently-open Document's real shard resolves (before any local edit can happen), since Y.UndoManager only tracks transactions made after it's constructed.

## 5. Scope is per open Document, not workspace-wide

Each Document has its own Y.Doc shard (#120), and the UndoManager follows: `undo()`/`redo()`/`subscribeUndoRedoState()` all take an explicit `doc` parameter (the currently-open Document's own resolved shard) rather than reaching for a single global instance. This section previously documented the opposite as deliberate, back when every Document shared one workspace-wide `Y.Doc` (`data-model.md` §4's now-superseded "One `Y.Doc` for the whole workspace" description) — that write-up itself already flagged the cross-document behavior as worth "revisit[ing] if user feedback shows [it]... is actually confusing in practice," and #120's shard split forces the revisit regardless: the workspace-wide doc undo was bound to no longer exists, so undo/redo would have silently stopped working entirely without this change.

Concretely, per-Document scoping is a strict improvement here, not just a forced consequence: editing Document A, navigating to Document B, and pressing Cmd/Ctrl+Z now reverts the last edit made _while B was open_, never reaching back into A's unrelated history — a more intuitive "undo affects what I'm looking at" model than the previous single-tab-wide stack. `move_document`'s parentDocumentId/order change is a catalog write plus a same-shard field mirror (`services/documents.ts`), not a Yjs transaction a Document's own UndoManager would track either way, so the old write-up's "a single transaction can span more than one Document" concern about `move_document` no longer applies.
