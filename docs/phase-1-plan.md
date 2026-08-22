# Phase 1 Plan

Phase 0 shipped (`cfe469a` — CRDT workspace, live UI, MCP agent access, all M0–M8 milestones). This organizes what's next into sequenced milestones, the same way `phase-0-build-plan.md` did for Phase 0. `phase-1-notes.md` stays as-is alongside this — the working rationale/exploration log this plan was assembled from; this doc is the "turn it into a plan" step it always intended to become.

**Depends on:** design-system.md (M1–M2 below), phase-1-notes.md (M3–M4), agent-workspace-prd.md's Phase 1 definition (M5).

---

## M1 — Design system rollout

- [ ] Add the `@theme` block + `@custom-variant dark` to `src/routes/layout.css` per design-system.md §1.
- [ ] Dark-mode toggle: a `.dark` class on `<html>`, persisted (`localStorage`), set before first paint to avoid a flash of the wrong theme.
- [ ] Load the three Google Fonts (design-system.md §2); apply the type scale to existing headings/body text across all current routes (workspace home, Document view, Table view, audit log, settings).
- [ ] Recolor the existing held-block placeholder (`+page.svelte`'s `.placeholder`/`.holder-avatar`/`.shimmer`) to the new tokens; add the label text if not already present.
- **Done when:** every existing Phase 0 screen uses the token palette and fonts, in both light and dark, with no leftover hardcoded colors from the original unstyled pass.

## M2 — Sidebar navigation + Document hierarchy

The feature that motivated this whole design pass: Google-Drive-style disorientation (losing all navigation context on opening a document) is exactly what a persistent sidebar with real hierarchy prevents.

- [ ] Extend `DocumentMeta` (currently `{id, title, recordIds}` in `src/lib/data/types.ts`) with `parentDocumentId?: string` and an `order: string` (fractional index, same pattern already used for block ordering) for sibling position in the tree. This settles something `phase-1-notes.md` left open (whether sub-pages need real nesting or just in-content references) — the sidebar needs an actual hierarchy, so it gets one.
- [ ] A "page-link" block type (in-content reference to another Document) stays a _separate_ concept from the hierarchy field — linking to a document doesn't make it a hierarchical child. Don't conflate the two.
- [ ] Sidebar component: persistent 236px panel (design-system.md §3), Documents tree + Collections list, collapse to a 44px icon rail. Add to the shared layout (`+layout.svelte`) so it persists across route changes — that persistence is the entire point.
- [ ] "New document" from the sidebar creates it as a child of the currently-open document (or top-level, if none is open) — wire this to the new `parentDocumentId` field.
- **Done when:** opening any document shows the full tree with your position in it highlighted, and it stays visible while navigating — never a bare document with no orientation, matching the acceptance bar from the design review.

## M3 — Additional block types

From `phase-1-notes.md`'s block-type survey (Notion + Gutenberg, filtered for local documentation rather than public content). All are cheap — new `blockType` + renderer + slash-command entry + Markdown transcoding, no architecture changes, per the PRD's original claim about the unified model.

- [ ] `callout`, `toggle`, `quote`, `divider` — styled per design-system.md §3.
- [ ] `to_do` refinement if not fully matching the checkbox property type's visual language yet.
- [ ] `table_of_contents` — a computed/live block (reads the current Document's own headings at render time), not stored content; design accordingly.
- [ ] `synced_block` — references another record's content by ID rather than owning its own; remember the hold subtlety from `phase-1-notes.md` (holding an instance must hold the _referenced_ record, not a separate copy).
- **Deferred, not in this milestone:** `image`/`file`/`video`/`audio` (need an asset-storage layer — real new infrastructure, not a cheap block addition) and `equation`/`column` (lower priority, cheap but not urgent). Revisit if dogfooding surfaces a concrete need.
- **Done when:** the slash-command menu offers the full set above, each renders and round-trips through Markdown correctly.

## M4 — Hybrid search (Postgres + pgvector)

From `phase-1-notes.md`'s content-retrieval section. A genuinely bigger infrastructure change than M1–M3 — migrating the read model off SQLite.

- [ ] Stand up Postgres (replacing SQLite for the `record_index` read model specifically — the `Y.Doc` snapshot/audit/token tables can stay SQLite unless there's a reason to move them too).
- [ ] Drizzle schema with a `tsvector` generated column (full-text) and a `vector` column via pgvector (semantic), per the guides already confirmed in `phase-1-notes.md`.
- [ ] `search_workspace` merges both result sets (reciprocal rank fusion or similar) instead of the Phase 0 FTS5-only query.
- [ ] Resolve the still-open question from `phase-1-notes.md`: where embeddings come from (hosted API vs. local model) — a real privacy tradeoff for a personal knowledgebase, not just an implementation detail.
- **Done when:** `search_workspace` returns relevant results for a natural-language agent query that shares no exact keywords with the target record.

## M5 — Multi-tenant: auth, workspace admin, per-user OAuth

The original PRD Phase 1 scope (agent-workspace-prd.md's Timeline Considerations) — sharing the tool with friends/collaborators. Bigger and more architecturally separate than M1–M4; recommend a dedicated technical-design pass (mirroring how `technical-design.md` was written before Phase 0 started) once this is actually prioritized, rather than speccing auth/permissions in a bullet list here.

- [ ] Authentication (currently: none — Phase 0 is trusted-local, single-user).
- [ ] Real workspace-admin role managing other people's membership/permissions (currently: the one user plays both roles implicitly).
- [ ] Per-user OAuth-style connection flow for external MCP clients, replacing Phase 0's single local access token.
- **Not started until M1–M4 are done and there's an actual second person to build for** — per the PRD's own reasoning for why Phase 0 was scoped solo in the first place.

---

## Sequencing notes

- M1 and M2 are tightly coupled (the sidebar is designed with the token system, not before it) — do M1 first, but don't let it fully finish before starting M2's data-model work (the `parentDocumentId` field and sidebar component can be built against tokens as they land).
- M3 has zero dependency on M1/M2 — could run in parallel if there's bandwidth, since it's pure data-model + slash-menu work.
- M4 is independent of M1–M3 but shares no urgency with them; sequence it whenever search quality actually becomes a felt problem in daily use, not on a fixed schedule.
- M5 is a distinct project, not a milestone to slot in opportunistically — treat the M1–M4 → M5 boundary as a real phase gate, matching the PRD's original Phase 0 → Phase 1 framing (built solo first, shared once proven).
