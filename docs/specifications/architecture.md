# Architecture — process model & app structure

**Depends on:** [`prd.md`](../prd.md) (all decisions there are inherited, not re-litigated here)

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
│                        │ In-memory Y.Doc (Phase 0: one │     │
│                        │          global shard)        │     │
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

**The Y.Doc/Awareness pair is resolved, not global.** Every boundary that touches workspace state — the `/ws` WebSocket handler, each `services/*.ts` function, and the read-only SvelteKit route loads — calls `resolveWorkspaceContext()` (`src/lib/server/workspace-store.ts`) rather than reaching a bare process-global singleton. That function is a real `{workspaceId, shardId} → {doc, awareness, connections}` registry: it's already exercised with more than one key in `workspace-store.test.ts`, proving two resolved contexts never share CRDT state, Awareness state, or persisted snapshot rows. Phase 0 itself only ever has one real workspace and no auth to pick a different one, so every current boundary calls `resolveWorkspaceContext()` with no selector and always gets the same default context back — a client-supplied value (e.g. the WebSocket room path segment) is accepted as a forward-compatible selector but is never treated as authority. This is the seam #13 (Y.Doc sharding strategy) and #6 (multi-space) build on: adding real per-workspace routing is a change to what selector a boundary resolves with, not a rewrite of how state is reached. See issue #30.

**Workspace-wide reads sit one layer above that resolver.** Listing every Document/Collection a caller may see (or searching across all of them) isn't a single-shard read: it's a catalog-first pass across the SQLite catalog (`src/lib/server/catalog.ts`), permission-filtered per item, with a fallback scan of the default shard for content written directly to the Y.Doc before it had a catalog row at all. `src/lib/server/workspace-repository.ts` (#191) is the one place that fan-out is implemented — `services/documents.ts#listDocuments`, `services/collections.ts#listCollections`, and `services/search.ts#searchWorkspace` all delegate to it rather than each re-deriving the same catalog-plus-fallback logic (which had already drifted between them before this existed).

**Capacity boundary (confirmed 2026-08-30).** The Phase 0 global shard is a
deliberate, bounded implementation, not the final multi-space architecture.
The [CRDT capacity baseline](../benchmarks/crdt-capacity-baseline-2026-08-30.md)
confirms it is suitable for a small daily workspace, while its larger profile
shows that every connected client pays for the whole global state. The next
architecture boundary is therefore document- and Collection-level Yjs shards,
with workspace navigation/catalog updates kept outside those content shards.
That is a direction validated by the baseline, not a claim that shard-aware
routing is shipped: Phase 0 still resolves every live connection to the one
default shard. [`workspace-sharding.md`](./workspace-sharding.md) (#112)
records the **approved** catalog/shard design, and #113 must prove it with
real per-shard transport measurements before this architecture can describe
it as implemented.

**Why HTTP MCP transport, not stdio:** Claude Desktop, Claude Code, and ChatGPT all support pointing at a remote MCP server via URL + bearer token in their own config (per the docs linked in the PRD). That matches the "simple local access token" decision better than stdio, which would mean each client spawns and manages its own subprocess — more moving parts for no benefit when everything's already running as one long-lived local service.

## 2. App structure (SvelteKit)

- `/` — workspace home: list of Documents and Collections.
- `/doc/[id]` — Document view: renders `recordIds` in order, each as an editable block component bound to that record's `Y.Text` (for content) via a Yjs Svelte binding; slash-command menu and formatting toolbar live here. See [`rich-text-toolbar.md`](./rich-text-toolbar.md) for their shared interaction contract.
- `/table/[id]` — Table view: schema editor + row grid, bound to the Collection's `recordIds` and each record's `properties`. Pre-existing, full-page route.
- Board and Calendar have no route of their own — they, and a second Table renderer, are `collection_view` Document blocks (`/doc/[id]`, inserted via the slash menu, rendered by `CollectionViewBlock.svelte`), embedded inline the same way a `page_link` block is. All three renderers share one query/projection path (`$lib/data/views.ts`) over the identical live record set `/table/[id]` uses — see [`collection-views.md`](./collection-views.md).
- `/settings/tokens` — create/revoke local access tokens (the current stand-in for OAuth), each with a document/collection allowlist.
- Shared `lib/yjs-client.ts` — wraps the y-websocket connection and exposes the same `Record`/`Document`/`Collection` read/write functions the MCP server uses server-side, so UI and MCP code share one data-access layer rather than duplicating it.
