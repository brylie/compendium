# Sync transport decision: staying on the bespoke `/ws` server (Hocuspocus evaluated)

**Depends on:** [`architecture.md`](./architecture.md), [`collaboration.md`](./collaboration.md), [`persistence.md`](./persistence.md), [`e2e-testing.md`](./e2e-testing.md), [`workspace-sharding.md`](./workspace-sharding.md)

**Decision:** Do not adopt [Hocuspocus](https://github.com/ueberdosis/hocuspocus) in place of the hand-rolled `/ws` server at this time. This is not a poor fit on the merits — it is premature relative to where Phase 0's single-process constraint currently sits. Revisit per §5.

---

## 1. Why this is a lower-risk kind of change

Hocuspocus is not an alternative CRDT: it is a server built directly on Yjs, speaking the same WebSocket sync protocol and y-protocols Awareness that `src/lib/server/yjs-ws-server.ts` / `attach-ws.ts` already implement by hand. Adopting it would not touch the CRDT/data-model layer at all — `data-model.md`, `Y.Text`-based markdown transcoding, `Y.UndoManager`-based undo/redo, and the holds system built on Awareness (`collaboration.md`) all carry over unchanged. This evaluation is scoped only to the transport/server boundary in `architecture.md` §1.

## 2. The stated reason for going bespoke may already be outdated

`architecture.md` §1 justifies the hand-rolled server over an adopted framework specifically because "an adopted framework would need to be convinced to expose its internal doc to a second, non-browser writer" — the MCP server needs direct, same-process, zero-latency access to the live `Y.Doc`, not a WebSocket round-trip, for the PRD's core "MCP writes and UI edits are indistinguishable" acceptance bet to hold.

Hocuspocus has a documented API for exactly this case: `openDirectConnection(documentName, context)` returns a connection whose `.transact()` gives direct, in-process mutation access to the live `Y.Doc`, with `onStoreDocument` still firing on the resulting change — no WebSocket hop required. This is a materially different capability than what was likely available when `architecture.md` §1 was written, and it weakens the stated case for staying bespoke.

## 3. What would still need real work

Protocol compatibility does not mean drop-in replacement. Specifically:

- **Document lifecycle mismatch.** A direct connection's default `disconnect()` behavior persists the document and unloads it from memory immediately. Compendium's current model resolves one `Y.Doc` per workspace/shard context via `resolveWorkspaceContext()` and holds it in memory for the life of the process (`persistence.md`, `architecture.md` §1's "resolved, not global" model). Matching that would require either `unloadImmediately: false` or one long-lived direct connection held per shard for the MCP server's lifetime — solvable, but a deliberate piece of integration work, not a default.
- **Persistence must be re-pointed, not replaced.** Hocuspocus ships its own persistence extensions (SQLite, Redis, a generic Database extension), but Compendium's `snapshots`/`audit_log`/`access_tokens`/`record_index` schema (`persistence.md`) is load-bearing and specific. Adopting Hocuspocus means implementing `onLoadDocument`/`onStoreDocument` hooks that call into the _existing_ Drizzle persistence path, not switching to Hocuspocus's own storage extensions, which would fork the persistence model.
- **Correctness risk at exactly the boundary this repo tests hardest for.** There is at least one open upstream issue describing direct-connection-related document state corruption. That failure class — a non-WebSocket writer diverging from WebSocket-observed state — is precisely what Tier A tests exist to catch (`e2e-testing.md`: "a token's document grant was correct in-memory for one MCP call and gone on the next" was a real prior bug of this shape). Adopting `openDirectConnection()` as the MCP write path would need genuine Tier A coverage proving convergence under concurrent WebSocket + direct-connection writes before it could be trusted, not a smoke test.

## 4. Where the actual payoff is, and why it isn't reachable yet

The headline capability Hocuspocus adds beyond protocol compatibility is the `@hocuspocus/extension-redis` horizontal-scaling story: multiple Node processes sharing document state via Redis pub-sub, which is a large amount of undifferentiated work to build yourself correctly.

That payoff is not actionable today. `architecture.md` §1 is explicit that Compendium is deliberately **one long-running local Node process** in Phase 0 — there is no second process for Redis fan-out to coordinate. Adopting Hocuspocus now would mean swapping one single-process transport implementation for a differently-shaped single-process transport implementation, without unlocking any scaling, while taking on the integration risks in §3.

## 5. Revisit triggers

Reopen this decision if either of the following happens, rather than on a fixed schedule:

- Real multi-process horizontal scaling is prioritized — most plausibly once the shard-aware routing in `workspace-sharding.md` (#112/#113) moves from approved design to implementation and a single process becomes the actual bottleneck the [capacity baseline](../benchmarks/crdt-capacity-baseline-2026-08-30.md) predicts.
- The hand-rolled `attach-ws.ts`/`yjs-ws-server.ts` wiring itself becomes a recurring maintenance burden (e.g., repeated bugs in reimplemented Awareness/connection-lifecycle handling that a maintained library would have already solved).

If either trigger fires, `openDirectConnection()` specifically needs a Tier A convergence test (concurrent WebSocket + direct-connection writers to the same document) before it can be adopted as the MCP write path — not just a feature-parity check.
