# Architecture — process model & app structure

**Depends on:** [`agent-workspace-prd.md`](../agent-workspace-prd.md) (all decisions there are inherited, not re-litigated here)

---

## 1. Process architecture

One long-running local Node process, no separate backend/frontend deployment:

```
┌─────────────────────────────────────────────────────────┐
│  Local server process (Node, SvelteKit adapter-node)     │
│                                                            │
│  ┌──────────────┐   ┌────────────────┐   ┌─────────────┐ │
│  │ SvelteKit UI  │   │ y-websocket     │   │ MCP server  │ │
│  │ (served pages)│◄─►│ endpoint        │   │ (HTTP,      │ │
│  └──────────────┘   │ (/ws)           │   │  /mcp)      │ │
│                      └────────┬────────┘   └──────┬──────┘ │
│                               │                    │        │
│                               ▼                    ▼        │
│                        ┌─────────────────────────────┐     │
│                        │   In-memory Y.Doc (workspace) │     │
│                        └──────────────┬───────────────┘     │
│                                       │                      │
│                                       ▼                      │
│                        ┌─────────────────────────────┐     │
│                        │  SQLite (persistence + audit)│     │
│                        └─────────────────────────────┘     │
└─────────────────────────────────────────────────────────┘
         ▲                                    ▲
         │ browser tab (WebSocket)            │ MCP client (HTTP)
    ┌────┴────┐                          ┌────┴─────────────┐
    │  You,    │                          │ Claude Desktop /  │
    │  the UI  │                          │ Claude Code /     │
    └─────────┘                          │ ChatGPT (config'd  │
                                          │ to point at /mcp)  │
                                          └───────────────────┘
```

**Why one process, not a client/server split with a real API:** the PRD's core acceptance criterion is that MCP writes and UI edits go through the _same_ sync engine and appear live to each other with no polling. The simplest way to guarantee that in Phase 0 is for the MCP server's tool handlers to mutate the same in-memory `Y.Doc` object the browser's y-websocket connection observes — not a separate database the UI polls. This is also exactly why a bespoke server is worth it here: an adopted framework would need to be convinced to expose its internal doc to a second, non-browser writer.

**Why HTTP MCP transport, not stdio:** Claude Desktop, Claude Code, and ChatGPT all support pointing at a remote MCP server via URL + bearer token in their own config (per the docs linked in the PRD). That matches the "simple local access token" decision better than stdio, which would mean each client spawns and manages its own subprocess — more moving parts for no benefit when everything's already running as one long-lived local service.

## 2. App structure (SvelteKit)

- `/` — workspace home: list of Documents and Collections.
- `/doc/[id]` — Document view: renders `recordIds` in order, each as an editable block component bound to that record's `Y.Text` (for content) via a Yjs Svelte binding; slash-command menu and formatting toolbar live here. See [`rich-text-toolbar.md`](./rich-text-toolbar.md) for their shared interaction contract.
- `/table/[id]` — Table view: schema editor + row grid, bound to the Collection's `recordIds` and each record's `properties`.
- `/settings/tokens` — create/revoke local access tokens (the current stand-in for OAuth), each with a document/collection allowlist.
- Shared `lib/yjs-client.ts` — wraps the y-websocket connection and exposes the same `Record`/`Document`/`Collection` read/write functions the MCP server uses server-side, so UI and MCP code share one data-access layer rather than duplicating it.
