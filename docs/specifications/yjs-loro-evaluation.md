# CRDT library decision: staying on Yjs (Loro evaluated)

**Depends on:** [`architecture.md`](./architecture.md), [`data-model.md`](./data-model.md), [`collaboration.md`](./collaboration.md), [`undo-redo.md`](./undo-redo.md), [`persistence.md`](./persistence.md)

**Decision:** Do not migrate from Yjs to [Loro](https://www.loro.dev/) at this time. This is a point-in-time evaluation, not a standing prohibition — see "Revisit triggers" below.

---

## 1. Why this was evaluated

Loro is a newer CRDT library that markets itself partly on developer ergonomics and structural editing (tree/movable-list moves without tombstone buildup). Compendium's entire sync model is Yjs-shaped by design (`architecture.md` §1: one `Y.Doc` per resolved workspace/shard context, shared by the UI's y-websocket connection, the MCP server's tool handlers, and SQLite persistence), so it's worth periodically confirming that dependency still earns its place rather than assuming it by default.

## 2. What Loro would actually replace

Yjs is not an implementation detail isolated behind one module — it is the data model. A migration would touch, at minimum:

- `src/lib/client/yjs-client.ts` — the single data-access layer shared by UI and server-side MCP code.
- `src/lib/data/yjs-typed.ts` / `yjs-shapes.ts` — the typed wrapper around raw Yjs containers (see §3).
- `src/lib/server/workspace-store.ts`, `attach-ws.ts`, `yjs-ws-server.ts` — the `/ws` transport and the `resolveWorkspaceContext()` registry.
- `src/lib/server/holds.ts` and `src/lib/client/presence.ts` — built directly on y-protocols Awareness (`collaboration.md`).
- `src/lib/data/markdown-transcode.ts` — the `Y.Text` ⇄ Markdown boundary, which relies on native `.format()` attribute ranges.
- `src/lib/client/undo.ts` — `Y.UndoManager`-based per-actor undo/redo (`undo-redo.md`).
- The SQLite snapshot format (`persistence.md`) — currently `Y.encodeStateAsUpdate` binary blobs.
- Every Tier A/Tier B test and the CRDT capacity benchmark (`e2e-testing.md` §6), all written against Yjs's convergence and merge semantics.

There is no path that lets Compendium keep Yjs's data model while adopting Loro. The separate [Loro Protocol](https://loro.dev/blog/loro-protocol) project (`loro-websocket`/`loro-adaptors`) does advertise Yjs compatibility, but that is wire-format transport interoperability only — it lets an existing Yjs sync/Awareness stream run over Loro's room-multiplexed WebSocket protocol. It does not convert or migrate actual `Y.Doc` content, or persisted `Y.encodeStateAsUpdate` snapshots, into Loro's native `LoroText`/`LoroMap`/`LoroList` containers. A CRDT-library swap — replacing the data model itself, which is what this note evaluates — would still be a ground-up rewrite, not an incremental one.

## 3. The "type safety" premise doesn't hold up

The prompt for this evaluation was Loro's marketing claim of improved type safety. Loro's JS API (`loro-crdt@1.13.3`, per the [get-started guide](https://loro.dev/docs/tutorial/get_started) and [API reference](https://loro.dev/docs/api/js) as of 2026-09-12) exposes typed container classes — `getText(name: string): LoroText`, `getMap(name: string): LoroMap`, etc. — and JSON export/import for interop and debugging. None of that is application-schema generation or validation: there is no way to declare that, say, a given `LoroMap` must have a `title: string` field and get a compile error or runtime check when something else writes to it. That is a different kind of type safety than the one Compendium actually needed.

Compendium already solved _that_ problem itself: issue #174 ("Expand typescript-eslint to more of the type-checked rule set via a Yjs type wrapper") added `yjs-typed.ts`'s `TypedYMap<T>` specifically to give `WorkspaceRecord` fields compile-time shape checking on top of raw Yjs containers. Loro's typed container classes address the same category of gap `TypedYMap<T>` already closes, not a category beyond it — migrating for type safety would mean discarding a wrapper that already does the job for no net gain.

## 4. Where Loro is structurally different, not just relabeled

- **Different algorithm.** Loro is Fugue-based; Yjs uses YATA. Every merge-semantics bug already found and fixed against Yjs's specific behavior — the `viewConfig` whole-value LWW clobbering in #71/#195/#219, the column-count concurrent-structural-edit invariant in #230 — would need to be independently re-verified under Loro's conflict resolution, not assumed to carry over.
- **No Awareness-protocol equivalent.** Yjs's Awareness (ephemeral, non-CRDT presence state) is what `collaboration.md`'s hold system is built on directly: a human's cursor is an implicit hold, `hold_records` reads aggregate Awareness across clients, and there are two independent TTLs (y-protocols' 30s `outdatedTimeout` plus a custom 100s `AGENT_HOLD_TTL_MS` in `holds.ts`) tuned against that specific model. Loro's closest primitive, `EphemeralStore`, is a different shape — this is a redesign of the holds system, not a port.
- **Transport-agnostic either way.** The `LoroDoc` library itself ships no built-in server or WebSocket transport, same as Yjs. The separate Loro Protocol project provides reference transport pieces (`loro-websocket`, a minimal `SimpleServer`), but adopting a transport is an independent decision from which CRDT data model Compendium uses, so it doesn't change the migration cost analyzed here.

## 5. Where Loro is genuinely stronger

`LoroTree` and `LoroMovableList` have native move operations with no permanent tombstones, which is a real, direct answer to the concurrent-structural-edit class of bug represented by issue #230. If block-reordering/move-conflict bugs become a recurring, costly pattern under Yjs's array-based approach, that specific pain point — not general type safety — is the concrete reason to reopen this evaluation.

## 6. Revisit triggers

Reopen this decision if any of the following happens, rather than on a fixed schedule:

- Concurrent structural-edit bugs (reordering, nesting, moves) become a recurring source of user-visible corruption beyond what #230-style fixes can contain.
- Loro ships a documented path for migrating existing `Y.Doc`/`Y.encodeStateAsUpdate` data into native Loro containers (not just wire-protocol interop), changing the "ground-up rewrite" cost in §2.
- The workspace/shard sharding work (`workspace-sharding.md`, #112/#113) surfaces a structural limitation in Yjs's document model specifically (not a Compendium-side implementation gap) that Loro's model would avoid.
