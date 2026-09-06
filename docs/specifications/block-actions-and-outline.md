# Block action menu, multi-select, and document outline (issue #152)

**Depends on:** [`prd.md`](../prd.md) — [Nice-to-Have (P1)](../prd.md#nice-to-have-p1)'s "Block action menu and document outline (List View)" item; [`data-model.md`](./data-model.md); [`rich-text-toolbar.md`](./rich-text-toolbar.md) (Enter/Backspace conventions and in-place conversion rules this reuses); [`block-capability-contract.md`](./block-capability-contract.md) §3.1 (per-block-type fields 5–6); [`design-system.md`](./design-system.md) §3 (the existing block move handle, issue #40, which this complements rather than replaces).

---

## 1. Purpose and scope

Every block already exposes a move handle (issue #40) for drag/keyboard reordering. This feature adds the rest of the everyday block-manipulation loop a word-processor-parity editor needs: duplicate, delete, convert, copy a durable link to a block, and move up/down without dragging — plus the ability to act on several blocks at once, and a document-level outline for navigating a long document without scrolling. All of it is UI-only, direct-to-`Y.Doc` behavior, following the same pattern the move handle, `setRecordChecked`, and `setRecordCollapsed` already established (`audit-coverage.md` covers it generically via the observer-based audit trail, not a dedicated service-layer call per action).

## 2. Block action menu

Every block row gets a second gutter control next to the move handle: a "…" (`BlockActionMenu.svelte`) trigger, hidden until the row is hovered or the trigger itself receives keyboard focus — the identical `opacity-0`/`group-hover`/`focus-visible` reveal pattern the move handle uses (`design-system.md` §3). It is a portalled dropdown (`fixed`-positioned off the trigger's own rect, so it escapes any `overflow` ancestor), modeled directly on `FieldMenu.svelte`'s existing menu mechanics — `role="menu"`/`role="menuitem"`, Up/Down roving focus, Escape/outside-click to close.

The menu offers, in order:

1. **Duplicate** — `duplicateRecord` (`src/lib/data/record-ops.ts`) inserts an exact copy immediately after the source, with fresh ids throughout. For a container block (`columns`/`column`, issue #148), duplication recurses into every child, in the same relative order, discarding the auto-seeded blank paragraph `createRecord` would otherwise leave in a freshly duplicated `column`. Provenance (`createdBy`/`createdAt`/`lastEditedBy`/`lastEditedAt`) is stamped fresh under the acting actor — a duplicate is new content, not a historical copy.
2. **Convert to…** — only offered when the block's own type is in the text-bearing set `rich-text-toolbar.md` §5 already defines (the same set the persistent toolbar converts in place); opens a submenu of the other text-bearing types, disabling the block's own current type. Selecting one calls `setBlockType` directly — the identical call the toolbar's own in-place-conversion path uses, so text and marks are preserved exactly the same way. Inside a `column`, the submenu is additionally filtered to `columnChildBlockTypes` (`data-model.md` §3.1) — offering a conversion target a column can't structurally hold (e.g. `callout`) would produce a state services/records.ts's own creation-time validation already forbids.
3. **Copy link to block** — writes `${origin}${pathname}#block-<id>` to the clipboard (`navigator.clipboard.writeText`), reusing the `id="block-<id>"` DOM convention every block row already carries (originally introduced for the inline `table_of_contents` block's own heading anchors). See §4 below for what opening that link does.
4. **Move up** / **Move down** — calls the same `moveBlock` function the move handle's own ArrowUp/ArrowDown keyboard path already uses (`reorderRecord` under the hood); disabled at the first/last position among the block's current siblings.
5. **Delete** — `deleteRecord`, with no confirmation dialog: this repository's per-actor undo/redo (`undo-redo.md`, a `Y.UndoManager`) is the safety net for an accidental block delete, the same way it already is for every other direct mutation in this editor (there is no confirmation on Backspace-deleting an empty block either). Focus lands on the previous sibling (or the next one, if the deleted block was first) — the same "focus never lands nowhere" convention `handleBackspace` already follows.

Every menu item is a real `<button role="menuitem">`, so the whole menu — not just the trigger — is keyboard operable: Tab to the trigger, Enter/Space to open, Up/Down to move between items, Enter/Space to activate, Escape to close (or to back out of the "Convert to…" submenu one level, matching `FieldMenu.svelte`'s own edit-mode Escape behavior).

## 3. Multi-select and group actions

Shift-clicking or Ctrl/Cmd-clicking a block's **move handle** (not the block's text, so it never collides with ordinary text selection) builds a multi-select set:

- **Shift-click** selects the contiguous range between the current selection's anchor and the clicked block, within that block's own parent container (the Document's top level, or one column).
- **Ctrl/Cmd-click** toggles one block in or out of the set, independent of contiguity.
- **Shift+ArrowUp/ArrowDown** on a focused move handle is the keyboard equivalent of Shift-click: it extends or shrinks the selection by one position from wherever the handle was focused, moving focus to the new edge of the range each time (so repeated presses keep working, the same "focus follows the action" convention the plain move handle's own ArrowUp/ArrowDown already uses).
- Selecting in a different parent container than the current selection replaces the set outright rather than mixing containers — every group operation below assumes one shared, orderable sibling list.
- Escape (on a focused move handle, or anywhere else in the document once a selection exists) clears the selection.

A non-empty selection renders a floating action bar (bottom-center, `role="toolbar"`) with **Duplicate**, **Move up**, **Move down**, **Delete**, and a count/clear control — a plain, Tab-reachable toolbar, so no separate keyboard path is needed beyond what already reaches its buttons.

- **Delete**/**Duplicate** act on every selected block, in their actual sibling order (not `Set` insertion order, which Ctrl-click toggling can scramble relative to document order) — both wrapped in one `Y.Doc` transaction, so the whole group's change is one undo step. A duplicated group's copies land the same way single-block duplication does (each copy immediately after its own source), so a selected, non-contiguous group's copies interleave with the originals rather than clustering together.
- **Move up**/**Move down** treat the selection as one unit, but only for a **contiguous** range — the buttons are disabled otherwise, since "move a scattered set up" has no single well-defined result. The implementation swaps the whole group with its one adjacent unselected neighbor (moving that neighbor to the far side of the group via `reorderRecord`), the natural generalization of the single-block move's own adjacent-swap.

## 4. Copy-link-to-block deep linking

Opening a Document URL with a `#block-<id>` fragment — whether pasted from "Copy link to block" or typed by hand — scrolls that block into view and focuses its editor once the Document's blocks have loaded, the same `scrollIntoView` + `focusEditor` + brief highlight pulse the List View's own row-click uses (§5). This runs once per navigation (guarded per `documentId`, not re-triggered by every subsequent edit-driven blocks refresh) via a `$effect` that inspects `page.url.hash` after the first successful load.

A block with no mounted `BlockEditor` (a structural type with no free-form text) still scrolls into view and highlights; there's simply no editor to focus.

## 5. List View / document outline

A toolbar-adjacent toggle (in the Document's breadcrumb row) opens a persistent right-side panel (`DocumentOutline.svelte`) listing **every** block in the Document, in true document order — including blocks nested inside a `columns` block's columns (`flattenDocumentBlocks`, `src/lib/data/record-ops.ts`), unlike the inline `table_of_contents` **block type**, which only lists headings and lives inside the document flow itself rather than as a persistent panel. The two are deliberately distinct features sharing only the "click to jump to a heading" idea.

Each row is indented by **heading hierarchy**, not just container nesting: a heading block closes any currently-open heading at its own level or deeper before opening its own level, and every non-heading block nests one level under whatever heading is currently open (on top of `depth`'s own container nesting, so a paragraph inside a column under a heading is indented for both). A structural block with no meaningful text (`divider`, `table`, `embed`, …) renders a short type label (e.g. "Divider") instead of a blank row.

Clicking any row scrolls to and focuses the corresponding block — the identical `scrollIntoView`/`focusEditor`/highlight-pulse behavior §4's deep link uses, since both are "go to this block" actions and should feel identical regardless of how the user got there.

## 6. Relationship to the move handle (#40) and the toolbar/slash-menu

This feature is additive, not a replacement:

- The move handle (issue #40) still owns drag-to-reorder and the plain (no-modifier) ArrowUp/ArrowDown/Home/End/ArrowLeft/ArrowRight keyboard reordering, including cross-column moves. The action menu's own Move up/down items call the exact same `moveBlock` function that keyboard path already uses — there is no second, divergent move implementation.
- Block insertion and in-place type conversion remain the persistent toolbar's and slash-menu's job (`rich-text-toolbar.md`). The action menu's "Convert to…" reuses that same text-bearing/structural distinction and the same `setBlockType` call, rather than introducing a second conversion path with different rules.
- Neither the action menu, multi-select, nor the outline panel alters holds, presence, permissions, or attribution — a held (placeholder) block still has no action menu of its own to interact with, the same way it has no mounted `BlockEditor` for the move handle's keyboard path to focus.

## 7. Verification contract

- Every block row exposes a "…" trigger, hidden until hover/focus, that opens a keyboard-navigable menu with Duplicate, (conditionally) Convert to…, Copy link to block, Move up, Move down, and Delete.
- Duplicate inserts an exact copy immediately after the source, preserving content and block-level fields, with fresh ids and fresh provenance; duplicating a `columns`/`column` block recurses into every child.
- Convert to… is offered only for text-bearing block types, excludes the block's own current type as a no-op-labeled but disabled choice, and preserves text/marks across the conversion; inside a column, the offered types are further restricted to what a column can structurally hold.
- Copy link to block places a `#block-<id>` URL on the clipboard; opening that URL scrolls to, focuses, and briefly highlights the named block once the Document has loaded.
- Move up/down in the menu match the move handle's own keyboard-move behavior exactly (same target position, same sibling-list scope).
- Delete removes the block with no confirmation dialog and moves focus to an adjacent sibling.
- Shift-click and Ctrl/Cmd-click on a move handle build a multi-select set scoped to one parent container; Shift+ArrowUp/Down does the same from the keyboard; Escape clears it.
- A non-empty selection shows a bulk action bar; Duplicate/Delete act on every selected block in document order as one transaction; Move up/down act on a contiguous selection as one unit and are disabled otherwise.
- The List View panel lists every block in the Document, in true document order including column-nested blocks, indented by heading hierarchy; clicking a row scrolls to and focuses that block.
- [`page.svelte.test.ts`](../../src/routes/space/[spaceId]/doc/[id]/page.svelte.test.ts)'s "block action menu (#152)", "multi-select and group actions (#152)", "List View / document outline (#152)", and "copy-link-to-block deep link (#152)" suites, plus [`BlockActionMenu.svelte.test.ts`](../../src/lib/components/BlockActionMenu.svelte.test.ts) and [`DocumentOutline.svelte.test.ts`](../../src/lib/components/DocumentOutline.svelte.test.ts), are the dedicated acceptance coverage for this contract; [`record-ops.test.ts`](../../src/lib/data/record-ops.test.ts)'s `duplicateRecord`/`flattenDocumentBlocks` suites cover the underlying data-layer primitives independent of any UI.
