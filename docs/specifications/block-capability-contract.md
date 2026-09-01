# Block capability contract

**Depends on:** [`prd.md`](../prd.md) — especially [Block editor interaction](../prd.md#block-editor-interaction-formatting--slash-command-insertion) and [Core Architectural Principle](../prd.md#core-architectural-principle-unified-data-model); [`data-model.md`](./data-model.md); [`rich-text-toolbar.md`](./rich-text-toolbar.md); [`markdown-transcoding.md`](./markdown-transcoding.md); [`collaboration.md`](./collaboration.md) (holds).

---

## 1. Purpose and scope

Every `BlockType` Compendium ships — existing or new — must define an explicit, checked capability contract before it reaches the slash-command menu, the toolbar, or the MCP surface. This exists because 0.4.0 alone adds four new block types (columns, math, diagram, and a richer bookmark/embed) on top of the existing catalogue: implementing each as a one-off would silently reintroduce per-block special cases into a model whose entire value proposition is uniform record/permission/hold/MCP handling (see Core Architectural Principle). This is not a new approval gate — it makes explicit and checkable the acceptance-criteria detail the PRD's block-editor requirements already imply.

## 2. Contract fields

A `BlockType`'s implementation issue must fill out all eleven fields before it merges:

1. **Icon + label** — slash-menu and toolbar display.
2. **Slash-command keywords/aliases** — including any conventional aliases (e.g., `/toggle`, `/details`, `/collapsible` all resolving to the same block).
3. **Content shape** — leaf text-bearing, structural, or container-with-children. Reuses the text-bearing/structural distinction `rich-text-toolbar.md` §5 already establishes; a container type (columns, toggle) additionally declares its child-block ordering semantics.
4. **Conversion compatibility** — which other types it converts to/from in place without data loss, per `rich-text-toolbar.md` §5's in-place-conversion vs. insert-new-block rule.
5. **Focus/Enter/Backspace/Escape behavior** — how the block participates in split/join editing (see the PRD's Enter/Backspace requirements) and what Escape does inside a container type.
6. **Drag/multi-select/group behavior** — whether the block can be part of a multi-select group action, and any constraints (e.g., a container's children move as a unit with their parent).
7. **Configuration UI and valid defaults** — if the block has settings (e.g., a callout's color variant, a diagram's render error state).
8. **Markdown read/write representation** — the block's shape at the MCP boundary per `markdown-transcoding.md`, including its graceful fallback when a connected client can't render it natively.
9. **Agent-readable structured representation** — only needed where Markdown is insufficient to express the block's full state (e.g., a `collection_view` block's `viewConfig`).
10. **Hold semantics** — whether this block type is safe to hold/replace/patch atomically during an agent write, per `collaboration.md`; a container type must state whether a hold on it implies holds on its children.
11. **Accessible static/read-only rendering** — screen-reader and keyboard-only access to the block's content independent of any live-editing affordance (e.g., a Mermaid diagram's raw source must remain available to assistive tech, since the rendered SVG isn't meaningfully accessible on its own).

## 3. Worked examples

### Toggle / collapsible (shipped, P0)

| Field | Value |
| --- | --- |
| Icon + label | Chevron icon; "Toggle list" |
| Keywords | `/toggle`, `/collapsible`, `/details` |
| Content shape | Container-with-children (one summary text run + an ordered list of child blocks) |
| Conversion | Converts to/from any text-bearing type by acting on its summary text only; converting away from toggle does not delete its children — they're re-parented to the toggle's former position |
| Focus/Enter/Backspace | Enter in the summary splits it like any text-bearing block; Enter at the end of the last child creates a new child; Backspace at the start of the first child does nothing special (does not collapse the toggle) |
| Drag/multi-select | Dragging the toggle moves it and all children as a unit; children are independently selectable/movable within the toggle |
| Configuration | None beyond expanded/collapsed state (a per-viewer UI state, not CRDT-synced content) |
| Markdown | `<details><summary>...</summary>...</details>` per `markdown-transcoding.md` |
| Agent representation | Markdown is sufficient |
| Hold semantics | Holding a toggle holds only its summary text by default; holding a specific child holds that child alone |
| Accessible rendering | Native `<details>`/`<summary>` semantics carry keyboard and screen-reader support for free |

### Diagram / Mermaid (#151, new in 0.4.0)

| Field | Value |
| --- | --- |
| Icon + label | Diagram icon; "Diagram (Mermaid)" |
| Keywords | `/diagram`, `/mermaid` |
| Content shape | Leaf (a single stored text run — the Mermaid source — with no child blocks) |
| Conversion | Converts to/from `code` (treated as a structural type per its render behavior, not a text-bearing one — see below) by preserving the raw source text; does not convert to/from prose types like paragraph or heading |
| Focus/Enter/Backspace | Structural block behavior: Enter/Backspace act on the block as a whole (create/remove), not on inline text, matching `code`'s existing treatment |
| Drag/multi-select | Standard single-block drag; no children |
| Configuration | None; render errors (invalid Mermaid syntax) show inline with the raw source, not a blank block |
| Markdown | Fenced code block with a `mermaid` language tag (` ```mermaid `), matching GitHub/GitLab's own convention |
| Agent representation | Markdown is sufficient — this is exactly why Mermaid was chosen over a freeform diagram editor: an agent can read and produce valid input deterministically |
| Hold semantics | Safe to hold/replace/patch as a single leaf value, identical to a `code` block |
| Accessible rendering | The raw Mermaid source is always available to assistive tech (e.g., as the rendered SVG's accessible description or an adjacent toggle to view source) — the rendered diagram alone is not sufficient |

## 4. Process

A new `BlockType` proposal (PRD addition or backlog issue) references this file and is expected to sketch answers to all eleven fields before implementation begins; the issue's own "Done when" criteria should restate them concretely rather than leaving them implicit. Missing fields are a signal the block type needs more design work, not a reason to skip the row.
