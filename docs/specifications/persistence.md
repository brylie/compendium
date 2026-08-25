# Persistence

**Depends on:** [`data-model.md`](./data-model.md), [`mcp-tools.md`](./mcp-tools.md) (`query_collection`/`search_workspace` read model consumers)

---

## 1. SQLite via Drizzle

[Drizzle](https://orm.drizzle.team/) (Apache 2.0 — same license as this project's own goal, not just compatible with it) manages every SQLite table, including the read model in §2 — one schema/migration story (`drizzle-kit`) instead of hand-written SQL for some tables and a separate library for others. It's also the SvelteKit-idiomatic choice: the Svelte CLI ships a built-in `drizzle` setup command.

- `snapshots` — periodic binary snapshots of the `Y.Doc` state (via `Y.encodeStateAsUpdate`), loaded on process start. Simpler than an update-log replay for now; revisit if snapshot size becomes a problem.
- `audit_log` — append-only: `id, actor_json, action, target_record_id, timestamp, diff_json`. Populated on every write/delete tool call, denied MCP attempt, and UI-originated write — including UI writes that bypass the service layer entirely, via a generic `Y.Doc`-level observer — satisfying the PRD's audit-log requirement; see [`audit-coverage.md`](./audit-coverage.md) for exactly what's covered, what's deliberately excluded, and how attribution and volume are handled.
- `access_tokens` — `token_hash, client_label, allowed_document_ids, allowed_collection_ids, created_at`. `client_label` is a free-text field set when the token is created (e.g., "Claude Desktop") — this is what powers the "Brylie · via Claude Desktop" attribution tag, since there's no per-vendor OAuth to source it from otherwise.

## 2. Query read model — Drizzle, not a reactive database

`query_collection` and `search_workspace` are **one-shot MCP tool calls**: an agent asks a question, gets an answer, done — there's no subscription involved, so a reactive-query engine (the original RxDB proposal) was solving a problem that doesn't exist on this path. A plain SQLite table, queried point-in-time through Drizzle's type-safe query builder, is the right-sized tool:

- `record_index` table: `record_id, parent_id, parent_type ('document' | 'collection'), plain_text_content, properties_json`, kept in sync **one-directionally** from `Y.Doc` changes (`Y.Doc` writes first, always — this table is a disposable projection, never a parallel write path; if it ever drifts, it's rebuildable by replaying the `Y.Doc`'s current state).
- `query_collection`'s `filter` maps onto a Drizzle `where` clause against `properties_json`; `search_workspace` uses SQLite's FTS5 virtual table over `plain_text_content` for full-text search — both plain request/response, no reactivity anywhere in this path.

**The Table view's live-updating grid is a different problem and doesn't need this table at all** — it's genuinely reactive (the UI should update as records change while you're looking at it), but that reactivity comes for free from the actual source of truth: a Svelte store derived from `Y.Doc` observers (`ymap.observe(...)`) on the relevant Collection, with filter/sort done client-side in a Svelte reactive statement. That keeps the UI's live-update path directly off Yjs rather than through an intermediate database — one less system to keep in sync, and no need for a reactive-database library at all once the one-shot query path is separated out.
