# Collaborative knowledge-editor UX research — implications for Compendium 0.4.0

**Date:** 2026-09-01  
**Purpose:** turn established interaction patterns in modern block editors into a small, coherent 0.4.0 roadmap. This is UX/product research, not a feature-count comparison.

## Executive conclusion

The successful products converge on one interaction contract: **a page is a calm writing surface made of manipulable blocks; structured data is the same source of truth rendered in context; reusable content makes intent explicit; and collaboration is visible without getting in the way.**

Compendium already has the unusually strong architectural half of that contract: typed block records, a shared Collection model with inline Table/Board/Calendar views, synced blocks, stable internal links/backlinks, Yjs live editing, and agent holds with attribution. 0.4.0 should therefore be a *coherence release*, not an attempt to catch up through a long block catalogue.

The recommended release has four outcomes:

1. Make every existing block easy to discover, insert, transform, move, duplicate, and configure.
2. Make Collection records feel like real knowledge objects—compact in a view, expandable for context—rather than spreadsheet rows.
3. Make reusable content intentional: distinguish a one-time template/pattern from a live synced reference, and make the latter’s blast radius legible.
4. Add the few high-frequency knowledge blocks missing from daily writing: image/file, bookmark/link preview, and Mermaid/diagram.

Do **not** add a separate canvas/whiteboard, formulas/automation, full WordPress-style site composition, or a large extension marketplace in 0.4.0. They expand the product surface much more than they improve the daily editor loop—and the first two would materially dilute Compendium’s agent-safe unified model.

## What the comparison set teaches

| Product | UX characteristic worth learning | Evidence | Compendium implication |
| --- | --- | --- | --- |
| **Notion** | A page is a stack of blocks; blocks can be inserted from `/`, rearranged, and converted in place. | [Notion: What is a block?](https://www.notion.com/help/what-is-a-block) | The editor needs a complete block manipulation loop, not only a slash menu and toolbar. Conversion should preserve content whenever it is semantically safe. |
| **Notion** | Database entries are themselves rich pages; the same data source has multiple per-view layouts and settings. | [Notion: databases](https://www.notion.com/help/intro-to-databases), [view settings](https://www.notion.com/help/views-filters-and-sorts) | Keep the Collection as one source of truth, but give each record a detail surface and give embedded views clear names, deep links, and durable configuration. |
| **Notion** | Properties support both work metadata and computed/provenance metadata; views can reveal only the fields appropriate to that context. | [Notion: database properties](https://www.notion.com/help/database-properties) | Add the highest-value schema types and system properties only after record detail UX exists. Do not make every field visible everywhere. |
| **Notion** | Synced content is visibly marked, shows where it is used, and can be detached. | [Notion: synced blocks](https://www.notion.com/help/synced-blocks) | Compendium’s synced blocks need source/instance affordances, a usage list, and a safe “detach to local copy” action. This is especially important when an agent edits the shared source. |
| **AFFiNE / BlockSuite** | Documents, a freeform “Edgeless” canvas, and databases coexist; Page and Edgeless support divergent thinking versus linear writing. Its recent releases also show ongoing investment in database views, document permissions, imports, and block metadata. | [AFFiNE Team](https://affine.pro/teamhub), [0.27 release](https://affine.pro/blog/whats-new-july-update-2026), [0.21 release](https://affine.pro/blog/whats-new-april-update) | The useful lesson is *mode separation*, not “build a canvas now.” A later visual mode should reuse canonical records and keep edits/audit/agent semantics intact; it must not become a second document system. |
| **Confluence** | The editor is a shared content surface: real-time coediting, mentions/comments, tables, media, Smart Links, macros, templates, and links to other first-class content types. | [Atlassian cloud editor](https://support.atlassian.com/confluence-cloud/docs/learn-about-the-atlassian-cloud-editor/), [content types](https://support.atlassian.com/confluence-cloud/docs/create-and-edit-content/) | Prioritize embeds, link previews, templates, and contextual actions. Do not copy comments/chat into the core product: Compendium’s PRD explicitly excludes chat, so agent-visible audit and inline work-state should be the collaboration differentiator. |
| **Confluence** | Databases can be edited from an embedded page/live-doc context; their views control layout, filters, sort, and visible fields. | [Confluence databases](https://support.atlassian.com/confluence-cloud/docs/get-started-with-confluence-databases/) | Validate the existing inline `collection_view` decision. Finish its UX: configuration, clear empty/broken states, record-opening behavior, and reusable saved-view presets later. |
| **WordPress Gutenberg** | Block composition is navigable at scale with a List View; groups make many blocks movable/configurable as a unit; patterns are either local starting points or synchronized shared content. | [Work with blocks](https://wordpress.org/documentation/article/work-with-blocks/), [patterns](https://wordpress.org/documentation/article/block-pattern/) | Add a document outline/List View and multi-select/group actions before adding obscure blocks. Treat **template/pattern** (copy-on-insert) and **synced block** (live reference) as deliberately different user promises. |
| **WordPress Gutenberg** | Blocks form an extensible, declarative capability model rather than a collection of bespoke page widgets. | [Gutenberg key concepts](https://developer.wordpress.org/block-editor/explanations/architecture/key-concepts/) | Define a compact internal Block Capability Contract now—icon, label, slash keywords, content shape, conversion rules, keyboard behavior, renderer, Markdown/MCP representation, and agent hold semantics—before broadening block types. |
| **Coda** | The document canvas includes interactive controls and actions; base tables can have many connected views, while personal filtering prevents one collaborator’s exploration from disrupting everyone. | [Coda filtering](https://help.coda.io/hc/en-us/articles/39555967334925-Overview-Filtering-tables), [Coda controls](https://help.coda.io/hc/en-us/articles/39555881969933-Filter-tables-via-controls) | Use the distinction between **saved shared view configuration** and **personal, temporary exploration**. 0.4.0 can introduce a local filter/search state without turning it into automation or a formula system. |
| **Coda** | An object map reveals tables, views, controls, formulas, and their dependencies; actions are explicit buttons, often supplied by integrations. | [Coda Doc Map](https://help.coda.io/hc/en-us/articles/39555955457165-Navigate-your-doc-via-the-doc-map), [Pack buttons](https://help.coda.io/hc/en-us/articles/39555960096653-Take-actions-with-Pack-buttons) | Compendium should first expose its existing link and synced-block relationships in a lightweight “references” view. Defer arbitrary action buttons until permissions, confirmation, provenance, and agent execution semantics are designed. |

## Cross-product UX principles

### 1. The editor must hide its structure until structure is useful

Writing begins as a normal document. On focus/hover/selection, the system reveals block handles, a contextual toolbar, insertion affordances, and keyboard commands. This “quiet canvas, powerful on demand” behavior is more important than visual similarity to Notion.

**Compendium gap:** the PRD specifies slash commands and conversion behavior; 0.4.0 should complete the companion direct-manipulation layer: drag handle, block menu, duplicate/delete, move up/down, multi-select, and a List View/outline. Every action needs keyboard equivalents.

### 2. A block is a semantic unit, not merely a rendering choice

Notion’s conversion, Gutenberg’s block capabilities, and Confluence’s macros all teach the same lesson: users expect a block to carry an intent that can be changed without retyping its content.

**Compendium standard:** each block type needs an explicit contract covering:

- insertion and conversion compatibility;
- focus, Enter, Backspace, and Escape behavior;
- drag/multi-select/group behavior;
- configuration UI and valid defaults;
- Markdown read/write fallback for MCP clients;
- an agent-readable structured representation where Markdown is insufficient;
- whether it is safe to hold, replace, or patch during an agent operation;
- an accessible static/read-only rendering.

This will prevent blocks such as embeds, collection views, diagrams, and media becoming special cases that break agent parity.

### 3. Reuse has two meanings—never conflate them

Gutenberg separates unsynced patterns from synced patterns. Notion makes a synced block’s shared nature and locations visible. The same distinction is essential in an agent-authored workspace.

| User intent | Product behavior | Compendium name/interaction |
| --- | --- | --- |
| “Start from this structure, then make it mine.” | Insert a private copy; later edits are local. | **Template** (or Pattern): browse, preview, insert, edit independently. |
| “Keep this information identical everywhere.” | Insert a live reference; edits propagate everywhere. | **Synced block**: source badge, instance count, “used in” list, jump-to-source, detach with confirmation. |

### 4. Structured records need progressive disclosure

Notion’s key insight is that a row/card is a page, not a dead cell. Confluence reaches the same result by enabling editing from embedded databases. The list/table is for scanning; a detail pane is for the surrounding evidence, links, and prose.

For Compendium, a Collection record should open in a side pane first (fast, retains the Board/Table/Calendar context), with a full-record route only when needed. The detail pane should include:

- title and editable properties;
- rich block body or linked document section;
- backlinks/relations;
- activity/last editor, including human-via-client and agent attribution;
- a focused “agent is working here” hold state.

This is a stronger use of the existing unified model than adding more views alone.

### 5. Views are a lens; personal exploration must not rewrite the shared workspace

Notion stores named view settings; Coda explicitly distinguishes personal filters from collaborative controls. Users need to browse a large collection without fear of changing another person’s dashboard.

**Recommended policy:** persisted named view configuration is shared; quick search, ad hoc filters, and temporary column tweaks are local by default, with an explicit “Save as view” action. This also reduces noisy CRDT writes.

### 6. Collaboration should answer “what changed, where, and by whom?”

Notion offers block-level presence and history; Confluence puts comments/mentions into the document. Compendium can do better for human-and-agent collaboration: not more chat, but truthful edit state—presence, agent hold, last editor, provenance, and one-action revert. Make this information available at the block and record level, not only in a global audit log.

## Recommended 0.4.0 scope

### P0 — editor coherence (release-defining)

1. **Block actions and document List View.** Hover handle/context menu; move, duplicate, delete, convert, copy link, and keyboard-accessible move actions. List View shows heading hierarchy and every block in order; click focuses the block. Support multi-select and group/ungroup as movement/formatting units, but not arbitrary nested data semantics yet.
2. **Polished block inserter.** Group commands by Writing, Structure, Media, Data, and Reuse; searchable aliases; show a short description and keyboard selection. Preserve the existing slash command contract.
3. **Record detail side pane.** Open a Collection row/card/calendar item without losing context. Start with properties, title, references/backlinks, activity, and a block body. This may be implemented as a child Document backed by the record ID or as a body field only if it preserves the single-record identity in MCP and audit APIs—choose one explicitly in the design.
4. **Synced-block safety UX.** Make source/instance state visible; show locations and offer detach. Warn before edits that propagate; attribute propagated agent changes to the original acting identity.
5. **Temporary versus saved collection exploration.** Local table search/filter and local column visibility; named saved views only via a deliberate save/duplicate action. Persisted embeds retain their current `viewConfig` behavior.

### P1 — high-frequency content blocks

6. **Image/file block.** Upload, paste, and drag/drop; caption/alt text; preview/download; graceful MCP Markdown representation. Treat attachment storage, permissions, deletion retention, and audit eventing as part of the capability—not follow-up details.
7. **Bookmark / Smart Link block.** Paste a URL and offer a link preview with title, description, favicon/thumbnail where available; always retain an accessible plain link. This supplies the high-value part of Confluence Smart Links without an integration platform.
8. **Mermaid diagram block.** A text source plus rendered preview, with safe failure state and raw-code fallback. It is a particularly good agent-native visual block because agents can produce and revise text deterministically; do not begin with a freehand diagram editor.
9. **Template gallery.** Begin with workspace-local document and block templates: preview, describe, insert copy. Seed a small set around current Compendium workflows (meeting note, project brief, research brief, decision record, task collection/dashboard).

### P2 — schema and view depth (only after record detail is useful)

10. **Property types:** add person/agent, URL, attachment, multi-select, status, and created/last-edited provenance. Add date ranges/times before a Timeline view. Each needs an MCP representation and a clear display value in Board/Calendar/card titles.
11. **View depth:** gallery/list and Timeline only when the supporting property/rendering interactions are ready. Add saved view presets and then optional shared dashboards. Do not ship a view merely because the renderer is easy.
12. **Relationship navigation:** a richer references panel/graph built from stable record IDs and backlinks. This is more useful than a generic graph visualization at first.

## Explicitly defer

- **Edgeless canvas/whiteboard.** AFFiNE validates the appeal of dual modes, but Compendium’s differentiation is auditable agent-safe shared content. A canvas needs a deliberate record projection, selection model, permission model, history model, and MCP/agent behavior.
- **Formula, rollup, button, automation, and Packs ecosystem.** Coda and Notion prove their power, but they create execution, credential, and dependency semantics. Compendium should first make agent actions explicit, attributable, scoped, and reversible.
- **Native threaded comments/chat.** The PRD’s non-goal is sound. Let audit/provenance, mentions, and external coordination tools cover the need until real evidence shows a missing workflow.
- **Full WordPress-style template/theme system.** A document template gallery is sufficient; global layout composition solves a publishing/CMS problem outside the 0.4.0 wedge.

## Acceptance criteria to add to the PRD

- Given a focused block, a user can insert, move, duplicate, delete, convert, or reach its configuration using keyboard-only interaction; conversion preserves content where defined by the block contract.
- Given a user opens List View, it reflects document order and headings immediately; selecting an item focuses and scrolls to the corresponding block.
- Given a Collection record is opened from Table, Board, or Calendar, it presents the same record identity and properties in a side pane; edits are reflected live in every view and through MCP.
- Given a user edits a synced-block instance, the UI identifies the source and all affected locations before the edit; a detach action produces an independent record with no stale references.
- Given two collaborators apply temporary filters/search to the same Collection, neither changes the other’s current view; saving a view makes its scope explicit.
- Given an agent holds a media, diagram, synced, or record-detail block, a human sees the same truthful held-state and provenance treatment as for a paragraph; unsupported rich content has a clear, non-destructive MCP fallback.

## Sequencing and success signals

Build P0 in the order: **block actions/List View → record detail → synced-block safety → local versus saved view state**. This front-loads the mechanics that every present and future block needs. Then add the three P1 content blocks through the capability contract, using the contract as the gate rather than treating each as a one-off UI feature.

Measure success with task completion rather than block counts:

- time from blank page to a usable project/research page;
- percentage of editor actions completed by keyboard;
- number of Collection records opened and edited from an embedded view;
- template insertion and repeat use;
- synced-block detach/use-location actions (a safety signal, not a vanity metric);
- agent edits reverted or retried because a human claimed a held block;
- median rendering/sync latency for pages containing the new media/diagram blocks.

## Source and confidence notes

All capability claims above use current first-party product documentation or product release notes. This brief intentionally does not rank competitors or infer internal architecture from marketing claims. AFFiNE documentation is less centralized than the other products, so its observations are limited to its official product pages and releases. Product behavior and naming change quickly; re-check source pages when converting a P1/P2 item into an implementation specification.
