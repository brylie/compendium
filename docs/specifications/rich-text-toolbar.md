# Rich-text toolbar

**Depends on:** [`agent-workspace-prd.md`](../agent-workspace-prd.md) — especially [Block editor interaction](../agent-workspace-prd.md#block-editor-interaction-formatting--slash-command-insertion); [`data-model.md`](./data-model.md) (§1 and §4); [`markdown-transcoding.md`](./markdown-transcoding.md).

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

The formatting group and the insert group are visually separated. The toolbar is a single row, always: the outer layout never wraps, and the insert group scrolls horizontally on narrow viewports rather than hiding supported block types or pushing either group onto a second line. Every control has an accessible label and, for formatting controls, `aria-pressed` reflects the active selection state.

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

An insert action creates the requested block immediately after the active block. If no block is active, it appends to the Document (or creates its first block). The new block is focused after creation. The toolbar does not reinterpret an existing block; converting the current block remains the slash-command flow until an explicit block-actions menu is specified.

`table` here is the inline Document block type. It is distinct from a configurable Collection Table view, whose design is specified separately in the Collection roadmap and data-model documentation.

### 5.1 Continuing a list with Enter

Pressing Enter in a `bulleted_list_item`, `numbered_list_item`, or `to_do` block continues the list — it inserts a new block of the same type immediately after, focused, rather than the default paragraph every other block type gets on Enter. This lets a person add several items with one toolbar click (to start the list) plus repeated Enter, matching the convention set by every mainstream block editor (Notion, Google Docs, etc.); requiring a fresh toolbar click per item was the toolbar reading as unpolished rather than as a block-insertion tool.

Pressing Enter on a list item that is currently **empty** exits the list instead of extending it: that item converts to a `paragraph` in place (same block, same position, still focused) rather than adding yet another empty item. This is the standard way to signal "done with the list" without a dedicated keyboard shortcut, and mirrors the same editors' convention. It reuses the normal `setBlockType` conversion path — the same one the slash-command menu uses — so it carries no special-cased storage behavior.

This is Enter-key behavior on an already-inserted block, not a toolbar action per se, but it is the toolbar's insert-a-list-item affordance that puts a person into this flow, so the contract belongs here rather than in a general editing-behavior spec.

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
- The toolbar never wraps onto a second row; the insert group scrolls horizontally instead.
- Every control shows an `aria-hidden` visible tooltip naming it, without duplicating its accessible name for assistive tech.
- Enter on a non-empty list item (`bulleted_list_item`, `numbered_list_item`, `to_do`) continues the list; Enter on an empty one converts it to a `paragraph` in place.
- Component tests cover control rendering/dispatch, selected-mark state, tooltip presence, layout (no wrap, insert group scrolls), and formatting/insertion/list-continuation through the Document page. The full repository lint, Svelte check, and production build remain required before merge.
