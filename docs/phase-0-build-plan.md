# Phase 0 Build Plan

Ordered, concrete task sequence for the personal MVP. Each milestone should be independently usable/testable before moving to the next — this is a solo build meant to be dogfooded incrementally, not built end-to-end before first use.

**Depends on:** agent-workspace-prd.md, technical-design.md

---

## M0 — Scaffolding

- [ ] `npx sv create` (SvelteKit), `adapter-node`, TypeScript.
- [ ] `LICENSE` file: Apache 2.0 (per PRD licensing intent), even before any public release — cheap to add now, awkward to retrofit later.
- [ ] Repo structure: `src/lib/data/` (record model + Yjs access layer, shared by UI and MCP server), `src/lib/mcp/` (MCP server), `src/routes/` (SvelteKit pages).
- **Done when:** `npm run dev` serves an empty SvelteKit page.

## M1 — Yjs core + persistence

- [ ] Single `Y.Doc` instance, created on server start.
- [ ] `y-websocket` server endpoint (`/ws`) wired to that doc.
- [ ] SQLite `snapshots` table; load latest snapshot on startup, save on a timer (e.g., every 30s of activity) and on clean shutdown.
- **Done when:** two browser tabs connected to `/ws` stay in sync on a trivial shared `Y.Map` value, and state survives a server restart.

## M2 — Data access layer

- [ ] Implement `Record`/`Document`/`Collection` types and CRUD functions (`getRecord`, `createRecord`, `updateRecordContent`, `updateRecordProperties`, `deleteRecord`, `listDocuments`, `listCollections`) against the `Y.Doc`, per technical-design.md §2–3.
- [ ] `record_index` table via Drizzle (§7.5), kept in sync one-directionally from `Y.Doc` updates. Write the sync function now even though nothing queries it yet — easier to verify against M2's own writes than to retrofit once M4/M6 depend on it.
- [ ] Unit tests for the CRDT-merge acceptance criteria from the PRD directly: concurrent overlapping bold/italic on one block merges correctly; a record created via this API is readable the same way regardless of which "view" logically created it.
- **Done when:** this layer works standalone against an in-memory `Y.Doc` with no UI — it's the thing both the UI and the MCP server will import.

## M3 — Document view

- [ ] Render a Document's ordered blocks; each block bound to its `Y.Text` for live editing.
- [ ] Rich-text toolbar (bold/italic/strikethrough/code/link) — calls `Y.Text.format()`, never inserts visible syntax.
- [ ] Slash-command menu: `/` opens a filterable menu; selecting inserts or converts the current block (paragraph, heading, list, table, code).
- **Done when:** you can write and format a real document end to end, refresh the page, and it's still there.

## M4 — Table view

- [ ] Collection schema editor: add/remove typed properties (text, number, date, select, checkbox, relation).
- [ ] Row grid: add/edit/delete rows (writes go through M2's `Y.Doc` API, never the `record_index` table directly).
- [ ] Grid filter/sort bound to a Svelte store derived from `Y.Doc` observers on the Collection — not the `record_index` table, which is for one-shot MCP queries only (§7.5).
- **Done when:** you can create a Collection, define a few properties, and manage rows without leaving the app.

## M5 — Hold, placeholder, and Awareness-based presence

- [ ] Wire Yjs Awareness: browser publishes `{actor, heldRecordIds}` on cursor move (debounced ~1.5s release on move-away).
- [ ] Placeholder rendering: any record held (per aggregate Awareness) renders as shimmer bars + holder's avatar, with a fade transition on the eventual content swap — not a hard cut.
- **Done when:** manually driving two browser tabs, moving a cursor into a block in one tab visibly blocks (in dev tools / a debug panel) a simulated hold request targeting that same block from succeeding.

## M6 — MCP server

- [ ] Implement the tool surface from technical-design.md §5 (`list_documents`, `get_document`, `list_collections`, `query_collection`, `search_workspace`, `hold_records`, `write_record`, `release_records`, `create_record`, `delete_record`).
- [ ] Markdown transcoding module (`markdown-transcode.ts`): CommonMark + GFM + `@mention` + `[[relation]]`, both directions.
- [ ] Local access tokens: create/store/verify (hashed) in SQLite; each token carries a document/collection allowlist checked on every tool call.
- [ ] `/settings/tokens` page: create a token, see its label and scope, revoke it.
- **Done when:** a hand-configured Claude Desktop or Claude Code MCP connection (per their own docs) can read a document, hold and write a block, and that edit appears live in an already-open browser tab.

## M7 — Attribution and audit log

- [ ] Attribution tagging: every write records its `ActorId`, including `human-via-client` with the token's `client_label` (e.g., "Brylie · via Claude Desktop").
- [ ] Hover/last-editor UI on blocks and rows.
- [ ] `audit_log` table populated on every write/delete; a minimal `/audit` page to filter by actor and time range.
- **Done when:** you can tell, for any block, who last touched it and how — and pull up everything a given connected client has done.

## M8 — Dogfood

- [ ] Connect Claude Desktop and/or Claude Code to the running server via their native MCP config.
- [ ] Move at least one real, currently-live project's notes/tasks into the workspace and use it for a week for actual work — not a demo.
- [ ] Track friction points directly (a Document in the workspace itself is a reasonable place for this list) rather than treating M0–M7 as "done" prematurely.
- **Done when:** per the PRD's Phase 0 success bar — you're actually choosing this over Notion/docs/chat for real project work, not just checking that the features exist.

---

## Sequencing notes

- M2 is the real foundation — M3 and M4 are both thin UI layers over it, and M6 imports it directly rather than reimplementing data access for the MCP path. Don't let UI polish on M3 block starting M4; they're independent once M2 exists.
- M5 (holds) can be built and tested with a fake/simulated agent client before M6 (the real MCP server) exists — worth doing in that order so the hold semantics are debugged before a real external client is in the loop.
- M7's attribution model has zero new mechanism once M5/M6 exist — it's mostly "make sure every write path actually records `ActorId`," which is easy to skip accidentally if it's not called out as its own milestone.
