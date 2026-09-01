# Rich-text toolbar

**Depends on:** [`prd.md`](../prd.md) — especially [Block editor interaction](../prd.md#block-editor-interaction-formatting--slash-command-insertion); [`data-model.md`](./data-model.md) (§1 and §4); [`markdown-transcoding.md`](./markdown-transcoding.md).

---

## 1. Purpose and scope

The persistent toolbar is the primary mouse/touch entry point for rich-text formatting and block insertion in a Document. It implements the PRD requirement that a human can format selected text without seeing or entering markup, while retaining keyboard shortcuts and the `/` command menu as complementary flows.

This is an editor interaction specification, not a second product PRD. Product rationale, MVP scope, agent parity, and acceptance criteria belong to the main PRD. The toolbar deliberately does **not** introduce a second editor model, a view-specific record type, or an MCP-only operation.

## 2. Storage and parity invariants

- A block's rich text is stored in its `Y.Text`. `RichText.runs` and `TextMarks` are its read-boundary representation; the toolbar never stores HTML or Markdown as document content.
- Formatting changes use `Y.Text.format()` over the selected range. Concurrent inline-format edits therefore use the same Yjs merge behavior as every other rich-text change.
- The native UI and MCP address the same `WorkspaceRecord`/`Y.Text`; the latter crosses its boundary through Markdown transcoding only, as defined in [`markdown-transcoding.md`](./markdown-transcoding.md). Markdown syntax is never exposed as an editing affordance in the native toolbar.
- Inserting a block uses the normal `createRecord` path. It creates a normal Document block with a normal `BlockType`, actor attribution, ordering, audit behavior, and collaboration behavior.

## 3. Toolbar layout and focus behavior

`Toolbar.svelte` is rendered at the top of `/doc/[id]` and remains sticky while the Document scrolls. Its formatting controls are disabled until a block editor is active; block-insert controls remain available so an empty Document can be started from the toolbar.

The formatting group and the insert group are visually separated. The toolbar is a single row, always: the outer layout never wraps, and insert controls that don't fit the available width collapse into a "More blocks" dropdown rather than being hidden outright or pushing either group onto a second line. Every insert control remains reachable — via the dropdown if not shown inline — and every control has an accessible label; for formatting controls, `aria-pressed` reflects the active selection state.

Clicking a formatting control must not collapse the native text selection before applying the operation. The toolbar prevents the control's pointer-down default for that reason; focus remains in the active `BlockEditor` and the operation applies to the selected range.

Every control also shows a visible tooltip on hover/focus, naming the control (icon-only buttons are not self-explanatory at a glance, and this toolbar has 23 of them). The tooltip is a sighted-user affordance layered on top of the control's `aria-label`, not a second accessible name — it is marked `aria-hidden` so assistive tech announces the control once, not twice. It does not replace the native `title` attribute so much as substitute for it: `title`'s long, inconsistent browser-default delay reads as a broken affordance on a toolbar this dense.

## 4. Formatting semantics

The v1 formatting controls map directly to the PRD's `TextMarks`:

| Toolbar control | `TextMarks` key | Behavior                                               |
| --------------- | --------------- | ------------------------------------------------------ |
| Bold            | `bold`          | Toggle over the selected range.                        |
| Italic          | `italic`        | Toggle over the selected range.                        |
| Strikethrough   | `strikethrough` | Toggle over the selected range.                        |
| Inline code     | `code`          | Toggle over the selected range.                        |
| Link            | `link`          | Prompt for a URL, then apply it to the selected range. |

Formatting requires a non-empty selection. The active state is true only when every selected rich-text run has the mark. For a collapsed selection, it is derived from the character after the caret, or the preceding character at the end of a block. This makes the visible state descriptive rather than an assertion that an empty-caret action will establish a future typing mark.

Keyboard shortcuts (`Cmd/Ctrl+B`, `I`, `X`, `E`, and `K`) invoke the same `BlockEditor` formatting primitive. Toolbar buttons and shortcuts must never diverge in mark storage or merge semantics.

## 5. Block insertion semantics

The toolbar provides a registered insert control for every currently supported `BlockType`:

- Paragraph; Heading 1–4; bulleted, numbered, and to-do list items.
- Quote, callout, toggle, divider, and code.
- Table, table of contents, synced block, page link, and embed.

For a control whose target is a **text-bearing** type (paragraph, any heading level, bulleted/numbered/to-do list, quote, callout, toggle, code) and the _active_ block is itself text-bearing, the control **converts that block in place**: its text and marks are preserved, only `blockType` changes, via the same `setBlockType` path the slash-command menu uses. This matches conventional word-processor toolbar behavior — clicking "Bulleted List" in Word or Google Docs turns the current paragraph into a list item, it does not insert a new one after it — and was a deliberate correction to this toolbar's original design, which inserted a new block after the active one for every control regardless of type.

If the active block's current type already matches the control clicked, it **toggles off** to `paragraph` instead of a no-op re-application — the same convention as clicking an already-pressed "Bulleted List" button in Word/Docs to remove the list formatting.

For a control whose target is a **structural** type (table, table of contents, synced block, page link, embed, divider), or when the active block is itself structural, or when no block is active — content shapes that a "keep my text, change its formatting" operation doesn't apply to — the control instead creates the requested block immediately after the active block (or appends to the Document, or creates its first block, when none is active). The new block is focused after creation. This keeps a structural block (a synced block, in particular) from having its own distinct content silently replaced by an in-place conversion meant for freeform text.

`table` here is the inline Document block type. It is distinct from a configurable Collection Table view, whose design is specified separately in the Collection roadmap and data-model documentation.

### 5.1 Continuing a list with Enter

Pressing Enter in a `bulleted_list_item`, `numbered_list_item`, or `to_do` block continues the list — it inserts a new block of the same type immediately after, focused, rather than the default paragraph every other block type gets on Enter. This lets a person add several items with one toolbar click (to start the list) plus repeated Enter, matching the convention set by every mainstream block editor (Notion, Google Docs, etc.); requiring a fresh toolbar click per item was the toolbar reading as unpolished rather than as a block-insertion tool.

Pressing Enter on a list item that is currently **empty** exits the list instead of extending it: that item converts to a `paragraph` in place (same block, same position, still focused) rather than adding yet another empty item. This is the standard way to signal "done with the list" without a dedicated keyboard shortcut, and mirrors the same editors' convention. It reuses the normal `setBlockType` conversion path — the same one the slash-command menu uses — so it carries no special-cased storage behavior.

This is Enter-key behavior on an already-inserted block, not a toolbar action per se, but it is the toolbar's insert-a-list-item affordance that puts a person into this flow, so the contract belongs here rather than in a general editing-behavior spec.

### 5.2 Enter splits text at the caret

Pressing Enter anywhere other than the very end of a block's text splits it: everything before the caret stays in the existing block, everything after it (with its marks intact) moves into a new block created immediately after. This is standard word-processor behavior — "Enter" divides a line at the cursor, it does not silently discard whatever came after it — and applies uniformly across every text-bearing block type (paragraphs, headings, list items, quote, callout, toggle, code — the same set §5 converts in place; not the structural types it insert-after instead). The one block-type-dependent choice is what the new block's type is: the same list type when continuing a list, `paragraph` otherwise, per §5.1.

**Which block ends up focused depends on where the caret was**, and this is the one place identity and content diverge:

- Caret anywhere **after** the start: the _original_ block (unchanged identity) keeps the text before the caret and stays focused; the _new_ block holds whatever came after and is not focused. This is the ordinary "keep typing where you were" case.
- Caret at the **very start** (offset 0) of non-empty text: the split still happens in the same position — an empty block first, the text-bearing block second — but focus follows the _empty_ block instead of the text. Focusing the text-bearing block here would mean every subsequent Enter at position 0 re-runs the same split against the _same_ content, leaving a trail of empty blocks behind while the real text keeps hopping into a fresh block each time, and — because the text-bearing block would never itself become the focused, empty block §5.1's exit rule looks for — a list would never reach that rule no matter how many times Enter was pressed there. Focusing the empty block instead means a second Enter immediately hits §5.1's ordinary empty-item behavior (exits a list to a paragraph; for a non-list block, empty blocks simply keep stacking above, matching plain word-processor behavior).

### 5.3 Backspace at the start joins the previous block

Pressing Backspace with a collapsed caret at the very start of a block's text — not just when the block is empty — joins that block's text onto the end of the previous block, the same way Backspace joins two lines in any word processor, rather than doing nothing (the caret has nowhere else to go inside an isolated block) or discarding the current block's content. Both blocks' marks are preserved; the caret lands at the join point (where the previous block's text used to end), not at the end of the merged result. An empty block still counts as "at the start" and is simply deleted, focus moving to the end of the previous block — unchanged from the original, simpler behavior.

This only applies when the previous block can hold free-form text (excludes the same structural types listed in §5). Backspace at the start of a non-empty block whose previous sibling is structural does nothing, rather than deleting the current block's content with nowhere to put it.

### 5.4 ArrowUp/ArrowDown cross block boundaries

Pressing ArrowUp with the caret on a block's visually topmost wrapped line, or ArrowDown on its bottommost line, moves focus into the adjacent block instead of the browser's default no-op at that edge — the keyboard-navigation counterpart to §5.2/§5.3's Enter/Backspace behavior, and part of the accessibility bar tracked by issue #18. The caret lands on the target block's first/last line, at the closest horizontal position to where it left the source block (best-effort column preservation via `caretRangeFromPoint`/`caretPositionFromPoint`; falls back to the target block's very start/end where point-based hit-testing isn't available).

This only intercepts an unmodified arrow key with a **collapsed** caret — a non-collapsed (ranged) selection keeps the browser's native ArrowUp/ArrowDown behavior (collapsing the selection to one end) untouched, and any modifier key (Shift, to extend a selection; Cmd/Ctrl/Alt, for OS-level shortcuts) is left alone entirely.

A held block (another actor's placeholder — `collaboration.md`) has no mounted editor to focus, so navigation skips past it to the next block that does. At the document's effective start/end — including when every block on the remaining side is held — the key is left to whatever native behavior applies, rather than being silently swallowed.

## 6. Extension point

[`toolbar-controls.ts`](../../src/routes/doc/[id]/toolbar-controls.ts) is the sole registration list for the current toolbar. A registration declares a stable ID, group, accessible label, compact label, and either a `TextMarks` key (`format`) or `BlockType` (`insert`). `Toolbar.svelte` renders controls generically from that list; adding a button within either category does not require changing the toolbar layout or branching its markup.

New control categories require an explicit interaction contract before implementation (for example, confirmation, audit attribution, and permissions for an agent-triggered action). They should not be smuggled into a text-format or block-insert registration merely to reuse the UI.

## 7. Relationship to slash commands and collaboration

Slash commands remain keyboard-first block conversion/insertion. The toolbar is the persistent, discoverable alternative; neither replaces the other. Both create the same block records and must expose the same supported block vocabulary.

The toolbar does not alter holds, presence, permissions, or attribution. Focusing a block continues to claim the existing human-presence hold, and a remote agent edit continues to be rendered through the same Yjs observer path. This keeps native editing and agent-driven editing on one synchronization model, as required by the PRD.

## 8. Verification contract

- A user can apply every supported formatting mark from the toolbar to a selection without literal markup appearing in the editor.
- The active formatting state follows changes to the current selection/caret.
- A user can create any supported block type from the toolbar, including heading, table, and embed.
- A toolbar insertion is a normal Document record creation and is visible to other Yjs clients.
- A control registration can be added without modifying `Toolbar.svelte`.
- The toolbar never wraps onto a second row; insert controls that don't fit collapse into the "More blocks" dropdown instead, and every one of them stays reachable there.
- Every control shows an `aria-hidden` visible tooltip naming it, without duplicating its accessible name for assistive tech.
- Enter on a non-empty list item (`bulleted_list_item`, `numbered_list_item`, `to_do`) continues the list; Enter on an empty one converts it to a `paragraph` in place.
- Enter at the very start of a non-empty list item's text, pressed twice, exits the list on the second press — never an endless string of empty items while the real text keeps relocating (see §5.2's focus rule).
- A text-bearing insert control converts the active block in place (text and marks preserved, only `blockType` changes) instead of inserting a new block, but only when the active block is itself text-bearing; a structural insert control, a structural active block (e.g. a synced block), or no active block still inserts; a control matching the block's own current type toggles it to `paragraph`.
- Enter mid-text splits the block at the caret: text before it stays, text after it (marks intact) moves into a new block — focused, except at caret offset 0, where the empty block stays focused instead (§5.2). This applies to every text-bearing block type, not only paragraphs/headings/lists.
- Backspace at the start of a non-empty block joins its text onto the end of the previous block (marks from both sides intact, caret at the join point), not just when the current block is empty.
- [`editing-conventions.svelte.test.ts`](../../src/routes/doc/[id]/editing-conventions.svelte.test.ts) is the dedicated acceptance suite for every rule in §5–5.3 — Enter, Backspace, and toolbar conversion — organized so each behavior is a named, independently-readable test rather than incidental coverage. Component tests elsewhere cover control rendering/dispatch, selected-mark state, tooltip presence, and layout (no wrap; overflow controls move to the dropdown, are all listed there, and are insertable from it). The full repository lint, Svelte check, and production build remain required before merge.
