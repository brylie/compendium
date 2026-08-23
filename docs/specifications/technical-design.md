# Technical Design — Phase 0

Translates [agent-workspace-prd.md](../agent-workspace-prd.md) into concrete engineering decisions for the personal MVP. Scope is Phase 0 only (single-tenant, local-trust, no login) — Phase 1+ concerns (multi-user auth, workspace admin, per-user OAuth) are explicitly out of scope for this doc and will get their own pass when that phase starts.

**Status:** Draft
**Depends on:** agent-workspace-prd.md (all decisions there are inherited, not re-litigated here)
**See also:** [`service-layer.md`](./service-layer.md) (centralizing permission/audit logic behind MCP and route handlers) and [`e2e-testing.md`](./e2e-testing.md) (testing MCP/UI parity across the real transport boundary) — split out as their own specs rather than folded in here, to keep this doc scoped to Phase 0's original architecture decisions.

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

**Why HTTP MCP transport, not stdio:** Claude Desktop, Claude Code, and ChatGPT all support pointing at a remote MCP server via URL + bearer token in their own config (per the docs linked in the PRD). That matches Phase 0's "simple local access token" decision better than stdio, which would mean each client spawns and manages its own subprocess — more moving parts for no benefit when everything's already running as one long-lived local service.

## 2. Data model

```typescript
type ActorId =
	| { kind: 'human'; userId: string }
	| { kind: 'agent'; agentId: string; name: string }
	| { kind: 'human-via-client'; userId: string; client: string }; // "Brylie · via Claude Desktop"

type PropertyValue =
	| { type: 'text'; value: string }
	| { type: 'number'; value: number }
	| { type: 'date'; value: string } // ISO 8601
	| { type: 'select'; value: string } // option id, defined in the Collection's schema
	| { type: 'checkbox'; value: boolean }
	| { type: 'relation'; value: string[] }; // record IDs

interface PropertyDefinition {
	key: string;
	label: string;
	type: PropertyValue['type'];
	options?: { id: string; label: string; color?: string }[]; // for 'select'
}

// A block IS a record — this isn't a separate type, just a record whose
// parent is a Document rather than a Collection. Kept as one shape so the
// MCP tool surface never needs to special-case "block vs. row."
interface Record {
	id: string; // stable, globally unique
	parentId: string; // Document ID or Collection ID
	order: string; // fractional index, orders records within parentId
	blockType?: string; // set when parent is a Document: 'paragraph' | 'heading' | 'list-item' | 'table' | 'code' | 'embed'
	content?: RichText; // set when parent is a Document — the block's text
	properties?: Record<string, PropertyValue>; // set when parent is a Collection
	createdBy: ActorId;
	createdAt: number;
	lastEditedBy: ActorId;
	lastEditedAt: number;
}

interface RichText {
	// Conceptually a run array (see PRD's Core Architectural Principle). Concretely,
	// realized as a Y.Text with formatting attributes — see §3. This TypeScript
	// shape is what the MCP boundary and the UI layer both see; the Y.Text
	// encoding is an internal storage detail behind it.
	runs: { text: string; marks: TextMarks }[];
}

interface TextMarks {
	bold?: boolean;
	italic?: boolean;
	strikethrough?: boolean;
	code?: boolean;
	link?: string;
	mention?: string; // ActorId's userId or agentId
}

interface Document {
	id: string;
	title: string;
	recordIds: string[]; // ordered — the Document's blocks, in order
}

interface Collection {
	id: string;
	title: string;
	schema: PropertyDefinition[];
	recordIds: string[]; // membership; row order within a view is a view concern, not stored here
}
```

## 3. Yjs mapping

One `Y.Doc` for the whole workspace (Phase 0 is single-tenant, single workspace — no need for multiple docs yet).

| Concept           | Yjs type                        | Notes                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documents index   | `Y.Map<string, DocumentMeta>`   | keyed by Document ID; `DocumentMeta` is `{title, recordIds: Y.Array<string>}`                                                                                                                                                                                                                                                                                             |
| Collections index | `Y.Map<string, CollectionMeta>` | keyed by Collection ID; includes `schema` as a plain JSON value (schema edits are rare, don't need fine-grained CRDT merge)                                                                                                                                                                                                                                               |
| Records           | `Y.Map<string, Y.Map>`          | keyed by record ID; each record's own `Y.Map` holds `parentId`, `order`, `blockType`, `properties` (plain JSON), and — for block-records — `content`                                                                                                                                                                                                                      |
| Block rich text   | `Y.Text`                        | one per block-record, stored as the record's `content` field. **Not** a custom run array — Yjs's own `Y.Text.format()` already stores marks as attribute ranges over the text and merges concurrent overlapping formatting correctly (see PRD's rich-text acceptance criterion). The `RichText.runs` shape in §2 is derived from `Y.Text` on read, not stored separately. |

**Why not a `Y.Text` per Document instead of one per block:** merging at the whole-document level would make block-level hold/release (§4) meaningless — the CRDT and the coordination layer need to operate at the same granularity. One `Y.Text` per block-record keeps them aligned.

## 4. Presence and holds — built on Yjs Awareness, not a custom channel

Yjs ships an **Awareness** protocol specifically for ephemeral, per-client state that isn't part of document content: cursor position, online status, and similar — it doesn't get persisted or CRDT-merged, and it auto-clears when a client disconnects. That's exactly the shape the PRD's hold mechanism needs, so holds are built on it rather than as a separate custom protocol:

- Each connected client (browser tab or MCP session) publishes an Awareness state: `{ actor: ActorId, heldRecordIds: string[] }`.
- **Human cursor presence → implicit hold:** the browser UI updates its own Awareness state's `heldRecordIds` to `[currentBlockId]` whenever the cursor moves, debounced ~1.5s on move-away (per PRD).
- **Agent hold request:** the MCP server's `hold_records` tool handler checks the _aggregate_ Awareness state across all connected clients for each requested record ID. A record already present in another client's `heldRecordIds` is denied for this request; everything else is granted. This directly implements the PRD's per-record (not all-or-nothing) acceptance criterion.
- **TTL:** Awareness states carry Yjs's built-in timeout (clears automatically if a client stops sending heartbeats) — this gives the 90–120s auto-release for free rather than needing custom expiry logic.
- **Placeholder rendering:** the UI subscribes to the aggregate Awareness state; any record ID held by an agent renders as the shimmer placeholder with that agent's avatar, sourced directly from the Awareness entry's `actor` field.

## 5. MCP tool surface

All tools operate on `Record` uniformly — no separate "block tools" vs. "row tools," per the PRD's unified-model requirement.

| Tool               | Input                                                 | Output                                              | Notes                                                                                        |
| ------------------ | ----------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `list_documents`   | —                                                     | `{id, title}[]`                                     |                                                                                              |
| `get_document`     | `documentId`                                          | `{id, title, records: {id, blockType, markdown}[]}` | `content` transcoded to Markdown at this boundary (§6)                                       |
| `list_collections` | —                                                     | `{id, title, schema}[]`                             |                                                                                              |
| `query_collection` | `collectionId, filter?`                               | `Record[]`                                          | backed by the Drizzle-managed read model (§7.5), not a direct `Y.Doc` walk                   |
| `search_workspace` | `query`                                               | `{recordId, snippet}[]`                             | full-text over block content + text/select properties, via the same read model (SQLite FTS5) |
| `hold_records`     | `recordIds: string[]`                                 | `{granted: string[], denied: string[]}`             | see §4; permission-checked per record before Awareness is checked                            |
| `write_record`     | `recordId, markdown \| properties`                    | `{success: boolean}`                                | requires an active hold for existing block content; atomic content-write + hold-release      |
| `release_records`  | `recordIds: string[]`                                 | `{success: boolean}`                                | explicit abandon, without writing                                                            |
| `create_record`    | `parentId, afterRecordId?, blockType? \| properties?` | `{recordId}`                                        | no hold needed — no prior content to protect                                                 |
| `delete_record`    | `recordId`                                            | `{success: boolean}`                                | no hold needed                                                                               |

**Permission scoping:** each access token (see §7) carries an allowlist of Document/Collection IDs. Every tool call checks the target record's `parentId` against that allowlist before touching Awareness or the `Y.Doc` — this is what "per-agent permission scoping" means concretely in Phase 0, even single-tenant: a token scoped to one Document can't read or write anything else, which is directly testable per the PRD's permission-denied acceptance criterion.

## 6. Markdown transcoding

Per the PRD: CommonMark + GFM (tables, task-list checkboxes, strikethrough) as the baseline, plus `@mention` and `[[Record Title]]` as workspace extensions.

- **Read path** (`Y.Text` → Markdown): walk the `Y.Text`'s formatted ranges, emit standard Markdown syntax for each mark (`**bold**`, `` `code` ``, `[text](url)`), plus `@mention` for a `mention` mark and `[[Title]]` for a `relation`-typed property value resolved to its target record's title.
- **Write path** (Markdown → `Y.Text`): parse with a standard CommonMark+GFM parser (e.g., `remark` — pure JS, no framework coupling, fits a bespoke SvelteKit-side build), walk the resulting AST, apply `Y.Text.format()` calls for each inline mark, and resolve `@mention`/`[[...]]` tokens against the workspace's actor/record indices before writing.
- Kept as a small internal module (`markdown-transcode.ts`) independent of both the UI and the MCP server, since both may eventually need it (e.g., pasting Markdown into the editor UI directly).

## 7. Persistence (SQLite via Drizzle)

[Drizzle](https://orm.drizzle.team/) (Apache 2.0 — same license as this project's own goal, not just compatible with it) manages every SQLite table, including the read model in §7.5 — one schema/migration story (`drizzle-kit`) instead of hand-written SQL for some tables and a separate library for others. It's also the SvelteKit-idiomatic choice: the Svelte CLI ships a built-in `drizzle` setup command.

- `snapshots` — periodic binary snapshots of the `Y.Doc` state (via `Y.encodeStateAsUpdate`), loaded on process start. Simpler than an update-log replay for Phase 0; revisit if snapshot size becomes a problem.
- `audit_log` — append-only: `id, actor_json, action, target_record_id, timestamp, diff_json`. Populated on every write/delete tool call and every UI-originated write, satisfying the PRD's audit-log requirement.
- `access_tokens` — `token_hash, client_label, allowed_document_ids, allowed_collection_ids, created_at`. `client_label` is a free-text field set when the token is created (e.g., "Claude Desktop") — this is what powers the "Brylie · via Claude Desktop" attribution tag, since Phase 0 has no per-vendor OAuth to source it from otherwise.

## 7.5. Query read model — Drizzle, not a reactive database

`query_collection` and `search_workspace` are **one-shot MCP tool calls**: an agent asks a question, gets an answer, done — there's no subscription involved, so a reactive-query engine (the original RxDB proposal) was solving a problem that doesn't exist on this path. A plain SQLite table, queried point-in-time through Drizzle's type-safe query builder, is the right-sized tool:

- `record_index` table: `record_id, parent_id, parent_type ('document' | 'collection'), plain_text_content, properties_json`, kept in sync **one-directionally** from `Y.Doc` changes (`Y.Doc` writes first, always — this table is a disposable projection, never a parallel write path; if it ever drifts, it's rebuildable by replaying the `Y.Doc`'s current state).
- `query_collection`'s `filter` maps onto a Drizzle `where` clause against `properties_json`; `search_workspace` uses SQLite's FTS5 virtual table over `plain_text_content` for full-text search — both plain request/response, no reactivity anywhere in this path.

**The Table view's live-updating grid is a different problem and doesn't need this table at all** — it's genuinely reactive (the UI should update as records change while you're looking at it), but that reactivity comes for free from the actual source of truth: a Svelte store derived from `Y.Doc` observers (`ymap.observe(...)`) on the relevant Collection, with filter/sort done client-side in a Svelte reactive statement. That keeps the UI's live-update path directly off Yjs rather than through an intermediate database — one less system to keep in sync, and no need for a reactive-database library at all once the one-shot query path is separated out.

## 8. App structure (SvelteKit)

- `/` — workspace home: list of Documents and Collections.
- `/doc/[id]` — Document view: renders `recordIds` in order, each as an editable block component bound to that record's `Y.Text` (for content) via a Yjs Svelte binding; slash-command menu and formatting toolbar live here.
- `/table/[id]` — Table view: schema editor + row grid, bound to the Collection's `recordIds` and each record's `properties`.
- `/settings/tokens` — create/revoke local access tokens (the Phase 0 stand-in for OAuth), each with a document/collection allowlist.
- Shared `lib/yjs-client.ts` — wraps the y-websocket connection and exposes the same `Record`/`Document`/`Collection` read/write functions the MCP server uses server-side, so UI and MCP code share one data-access layer rather than duplicating it.

## 9. Explicitly out of scope for this doc

Everything in the PRD's Phase 1+ (multi-user auth, workspace admin, per-user OAuth, Kanban/Calendar views, multi-agent concurrent editing, rate limits, revert, sandbox workspace, formula/spreadsheet, chat integration). Revisit with a new technical design pass when Phase 1 starts.
