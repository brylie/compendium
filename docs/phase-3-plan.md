# Phase 3 Plan — UX refinement & Notion-like architecture extension

**Status:** Placeholder — not yet planned in detail.

This phase picks back up on UX and extends the architecture further toward a Notion-like editing experience, still on the single-user, SQLite-backed foundation Phase 1 and Phase 2 establish (no Postgres, no multi-tenant auth — those stay deferred in [`phase-4-plan.md`](./phase-4-plan.md)). It's intentionally left unplanned here rather than speculatively scoped, for two reasons:

- **It depends on Phase 2's outcome.** Phase 2 (service layer + testing) may surface architectural constraints or rework that changes what's cheap vs. expensive to build here — the milestones in this doc should be written after that's known, not guessed at now.
- **The actual UX issues haven't been discussed yet.** Milestones will be added here once that conversation happens, the same way `phase-1-plan.md` was built from `phase-1-notes.md`'s working exploration log rather than invented cold.

**Depends on:** `phase-2-plan.md` (architecture must be solid before extending on top of it), a not-yet-written UX notes/exploration doc (the `phase-1-notes.md` equivalent for this phase).

---

## What "Notion-like" is pointing at (directional, not a commitment)

Loose scope markers for the conversation this doc is waiting on — not milestones yet:

- Richer in-document navigation and editing ergonomics beyond what M1–M3 shipped (Phase 1's design system and hierarchy were the foundation, not the ceiling).
- Whatever UX friction actually surfaces from real single-player daily use in the meantime — per the PRD's own Phase 0/1 bar ("does the founder actually keep using this daily... instead of reverting to Notion/docs/chat"), that lived experience is the input this phase should be planned from, not a feature checklist copied from a competitor.

## Next step

Once Phase 2 lands (or is far enough along to know its architectural shape), have the UX discussion this phase needs, capture it as a notes doc, and turn it into real milestones here — mirroring how `phase-1-notes.md` → `phase-1-plan.md` worked.
