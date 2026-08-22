# Phase 4 Plan — Hybrid search & multi-tenant

**Status:** Deferred, not started. Relocated from `phase-1-plan.md`'s original M4/M5 — the content below is unchanged from that plan, just moved: neither hybrid search nor multi-tenant auth is a requirement for a solid single-user MVP, and Phase 1–3 all stay on the single-user, SQLite-backed architecture. Revisit this phase once Phase 3 is done and search quality or a second real user actually become felt problems — not on a fixed schedule.

---

## M1 — Hybrid search (Postgres + pgvector)

From `phase-1-notes.md`'s content-retrieval section. A genuinely bigger infrastructure change than anything in Phase 1–3 — migrating the read model off SQLite.

- [ ] Stand up Postgres (replacing SQLite for the `record_index` read model specifically — the `Y.Doc` snapshot/audit/token tables can stay SQLite unless there's a reason to move them too).
- [ ] Drizzle schema with a `tsvector` generated column (full-text) and a `vector` column via pgvector (semantic), per the guides already confirmed in `phase-1-notes.md`.
- [ ] `search_workspace` merges both result sets (reciprocal rank fusion or similar) instead of the Phase 0 FTS5-only query.
- [ ] Resolve the still-open question from `phase-1-notes.md`: where embeddings come from (hosted API vs. local model) — a real privacy tradeoff for a personal knowledgebase, not just an implementation detail.
- **Done when:** `search_workspace` returns relevant results for a natural-language agent query that shares no exact keywords with the target record.

## M2 — Multi-tenant: auth, workspace admin, per-user OAuth

The original PRD Phase 1 scope (`agent-workspace-prd.md`'s Timeline Considerations) — sharing the tool with friends/collaborators. Bigger and more architecturally separate than M1; recommend a dedicated technical-design pass (mirroring how `technical-design.md` was written before Phase 0 started) once this is actually prioritized, rather than speccing auth/permissions in a bullet list here.

- [ ] Authentication (currently: none — the workspace is trusted-local, single-user, through Phase 1–3).
- [ ] Real workspace-admin role managing other people's membership/permissions (currently: the one user plays both roles implicitly).
- [ ] Per-user OAuth-style connection flow for external MCP clients, replacing the single local access token.
- **Not started until there's an actual second person to build for** — per the PRD's own reasoning for why Phase 0 was scoped solo in the first place; this bar hasn't moved just because the phase number did.

---

## Sequencing notes

- M1 is independent of M2 and of everything in Phase 1–3; sequence it whenever search quality actually becomes a felt problem in daily use.
- M2 is a distinct project, not a milestone to slot in opportunistically — treat the boundary into M2 as a real phase gate, matching the PRD's original Phase 0 → Phase 1 framing (built solo first, shared once proven). A second person actually needing access is the trigger, not a plan date.
