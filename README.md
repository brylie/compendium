# AgentSpace

A personal, single-tenant, agent-first workspace: a CRDT-backed document and
table editor where a human (via the web UI) and AI agents (via MCP) read and
write the same content with the same fidelity, live.

This is the **Phase 0** build — see [`docs/agent-workspace-prd.md`](docs/agent-workspace-prd.md),
[`docs/technical-design.md`](docs/technical-design.md), and
[`docs/phase-0-build-plan.md`](docs/phase-0-build-plan.md) for the full spec
and rationale. Phase 0 is trusted-local, single-user, no login.

## Running it

```sh
npm install
npm run dev          # http://localhost:5173, with /ws and /mcp on the same port
```

For a production-style run (one process, adapter-node build):

```sh
npm run build
ORIGIN=http://localhost:3000 npm start
```

`ORIGIN` should match whatever host/port you're actually serving on — SvelteKit's
CSRF protection checks the request's `Origin` header against it for POSTs
(browsers send this automatically; only matters if you're scripting requests).

## Connecting an MCP client

1. Create a document or collection from the workspace home page.
2. Go to **Tokens** (`/settings/tokens`), create a token scoped to the
   documents/collections you want to grant access to.
3. Point your MCP client (Claude Desktop, Claude Code, ChatGPT, etc.) at
   `http://localhost:3000/mcp` with that token as a bearer token, per your
   client's own remote-MCP-server configuration.

Edits made this way appear live in any open browser tab — MCP writes and UI
edits go through the same in-memory `Y.Doc` (see `docs/technical-design.md §1`).

## Project layout

- `src/lib/data/` — the record/Document/Collection model and CRDT access
  layer (`records.ts`), shared verbatim by the UI and the MCP server.
- `src/lib/server/` — the Yjs document singleton, SQLite persistence,
  Awareness-based holds, and the audit log. Server-only (SvelteKit enforces
  this by directory convention).
- `src/lib/mcp/` — the MCP tool surface, Markdown transcoding
  (CommonMark+GFM plus `@mention`/`[[wiki-link]]`), and access tokens.
- `src/lib/client/` — browser-side Yjs connection, presence/hold publishing,
  and the bespoke contenteditable rich-text binding's caret/diff helpers.
- `src/routes/` — the SvelteKit UI: workspace home, Document view, Table
  view, token settings, and the audit log.
- `server.ts` — production entry point; wraps the adapter-node build's
  request handler with a raw `http.Server` so `/ws` can share the port.

## Testing

```sh
npm run test    # vitest — data layer, holds, and markdown transcoding
npm run check   # svelte-check
npm run lint    # prettier + eslint
```
