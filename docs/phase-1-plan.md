# Phase 1 Plan

Phase 0 shipped (`cfe469a` — CRDT workspace, live UI, MCP agent access, all M0–M8 milestones). This organizes what's next into sequenced milestones, the same way `phase-0-build-plan.md` did for Phase 0. `phase-1-notes.md` stays as-is alongside this — the working rationale/exploration log this plan was assembled from; this doc is the "turn it into a plan" step it always intended to become.

**Depends on:** design-system.md (M1–M2 below), phase-1-notes.md (M3).

**Scope note (revised):** what were originally M4 (hybrid search / Postgres) and M5 (multi-tenant auth) are **not core to a solid single-user MVP** and have moved out to [`phase-4-plan.md`](./phase-4-plan.md) — they're still on the roadmap, just no longer blocking or sequenced here. This phase is now scoped to M1–M3 only: get the single-user experience (design system, navigable hierarchy, full block-type set) solid on the existing SQLite-backed architecture. [`phase-2-plan.md`](./phase-2-plan.md) (testing + the service layer) and [`phase-3-plan.md`](./phase-3-plan.md) (UX + Notion-like architecture extension) continue that same single-user-on-SQLite line after this phase, before hybrid search or multi-tenancy are revisited.

---

## M1 — Design system rollout

- [x] Add the `@theme` block + `@custom-variant dark` to `src/routes/layout.css` per design-system.md §1.
- [x] Dark-mode toggle: a `.dark` class on `<html>`, persisted (`localStorage`), set before first paint to avoid a flash of the wrong theme.
- [x] Load the three Google Fonts (design-system.md §2); apply the type scale to existing headings/body text across all current routes (workspace home, Document view, Table view, audit log, settings).
- [x] Recolor the existing held-block placeholder (`+page.svelte`'s `.placeholder`/`.holder-avatar`/`.shimmer`) to the new tokens; add the label text if not already present.
- **Done when:** every existing Phase 0 screen uses the token palette and fonts, in both light and dark, with no leftover hardcoded colors from the original unstyled pass.

## M2 — Sidebar navigation + Document hierarchy

The feature that motivated this whole design pass: Google-Drive-style disorientation (losing all navigation context on opening a document) is exactly what a persistent sidebar with real hierarchy prevents.

- [x] Extend `DocumentMeta` (currently `{id, title, recordIds}` in `src/lib/data/types.ts`) with `parentDocumentId?: string` and an `order: string` (fractional index, same pattern already used for block ordering) for sibling position in the tree. This settles something `phase-1-notes.md` left open (whether sub-pages need real nesting or just in-content references) — the sidebar needs an actual hierarchy, so it gets one.
- [ ] A "page-link" block type (in-content reference to another Document) stays a _separate_ concept from the hierarchy field — linking to a document doesn't make it a hierarchical child. Don't conflate the two. **Un-checked on architecture review** — this was marked done but never implemented (no such `blockType` exists anywhere in the codebase); either build it or leave it explicitly deferred, but don't re-check it without one of those being true.
- [x] Sidebar component: persistent 236px panel (design-system.md §3), Documents tree + Collections list, collapse to a 44px icon rail. Add to the shared layout (`+layout.svelte`) so it persists across route changes — that persistence is the entire point.
- [x] "New document" from the sidebar creates it as a child of the currently-open document (or top-level, if none is open) — wire this to the new `parentDocumentId` field.
- **Done when:** opening any document shows the full tree with your position in it highlighted, and it stays visible while navigating — never a bare document with no orientation, matching the acceptance bar from the design review.
- **Follow-up from architecture review:** an MCP/UI parity review of this milestone found real gaps (an MCP `create_document` grant that never persists, no `move_document` MCP tool, an unaudited UI fallback write path, a checked-off `page-link` block type that was never built). Fixing these is tracked outside this checklist; see [`service-layer.specification.md`](./service-layer.specification.md) (the architectural fix — centralize permission/audit logic so this class of bug can't recur) and [`e2e-testing.specification.md`](./e2e-testing.specification.md) (the test coverage that should have caught it).

## M3 — Additional block types

From `phase-1-notes.md`'s block-type survey (Notion + Gutenberg, filtered for local documentation rather than public content). All are cheap — new `blockType` + renderer + slash-command entry + Markdown transcoding, no architecture changes, per the PRD's original claim about the unified model.

- [x] `callout`, `toggle`, `quote`, `divider` — styled per design-system.md §3.
- [x] `to_do` refinement if not fully matching the checkbox property type's visual language yet.
- [x] `table_of_contents` — a computed/live block (reads the current Document's own headings at render time), not stored content; design accordingly.
- [x] `synced_block` — references another record's content by ID rather than owning its own; remember the hold subtlety from `phase-1-notes.md` (holding an instance must hold the _referenced_ record, not a separate copy).
- **Deferred, not in this milestone:** `image`/`file`/`video`/`audio` (need an asset-storage layer — real new infrastructure, not a cheap block addition) and `equation`/`column` (lower priority, cheap but not urgent). Revisit if dogfooding surfaces a concrete need.
- **Done when:** the slash-command menu offers the full set above, each renders and round-trips through Markdown correctly.

---

## Moved to a later phase

Hybrid search (Postgres + pgvector) and multi-tenant auth were originally scoped here as M4/M5. Neither is a requirement for a solid single-user MVP — SQLite's FTS5 search and Phase 0's single local token carry a single-player workspace a long way. Both are still on the roadmap, just relocated to [`phase-4-plan.md`](./phase-4-plan.md) so they stop competing with the single-user-experience work in this phase and in Phase 2/3.

---

## Sequencing notes

- M1 and M2 are tightly coupled (the sidebar is designed with the token system, not before it) — do M1 first, but don't let it fully finish before starting M2's data-model work (the `parentDocumentId` field and sidebar component can be built against tokens as they land).
- M3 has zero dependency on M1/M2 — could run in parallel if there's bandwidth, since it's pure data-model + slash-menu work.
- Once M1–M3 are done, continue with [`phase-2-plan.md`](./phase-2-plan.md) (testing + service layer) before [`phase-3-plan.md`](./phase-3-plan.md) (UX + architecture extension) — both stay on the single-user SQLite architecture; see those docs for why that order.
