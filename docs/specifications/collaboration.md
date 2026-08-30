# Presence and holds

**Depends on:** [`data-model.md`](./data-model.md) §2 (Yjs mapping)

---

Built on Yjs Awareness, not a custom channel. Yjs ships an **Awareness** protocol specifically for ephemeral, per-client state that isn't part of document content: cursor position, online status, and similar — it doesn't get persisted or CRDT-merged, and it auto-clears when a client disconnects. That's exactly the shape the PRD's hold mechanism needs, so holds are built on it rather than as a separate custom protocol:

- Each connected client (browser tab or MCP session) publishes an Awareness state: `{ actor: ActorId, heldRecordIds: string[] }`.
- **Human cursor presence → implicit hold:** the browser UI updates its own Awareness state's `heldRecordIds` to `[currentBlockId]` whenever the cursor moves, debounced ~1.5s on move-away (per PRD).
- **Agent hold request:** the MCP server's `hold_records` tool handler checks the _aggregate_ Awareness state across all connected clients for each requested record ID. A record already present in another client's `heldRecordIds` is denied for this request; everything else is granted. This directly implements the PRD's per-record (not all-or-nothing) acceptance criterion. Accurate for Phase 0's single global `Y.Doc`/Awareness pair; [`workspace-sharding.md`](./workspace-sharding.md) (#112, approved) moves Awareness to be shard-local once #113 lands, with a separate workspace-scoped hold coordinator (§3.3) aggregating across shards for a cross-document agent batch — the per-record semantics above don't change, only where the aggregation happens.
- **TTL:** two distinct timeouts are involved, not one:
  - y-protocols' own Awareness implementation clears any client's state after **30s** of no heartbeat (`outdatedTimeout`) — this is what catches an abruptly-dropped connection (e.g. a browser tab closing without a clean disconnect).
  - Agent holds additionally carry a dedicated **100s** `AGENT_HOLD_TTL_MS` timer (`src/lib/server/holds.ts`), scheduled server-side whenever a hold is granted or renewed, sitting inside the PRD's 90–120s auto-release target. This is what auto-releases a hold an agent forgot to explicitly release even while its underlying connection/token is still otherwise alive — the 30s Awareness timeout alone wouldn't cover that case, since a stateless MCP agent has no persistent heartbeat to time out in the first place.
  - A clean WebSocket disconnect (a real browser tab) additionally clears that connection's own Awareness clients immediately, rather than waiting out either timeout — see `src/lib/server/yjs-ws-server.ts`'s close handler.
- **Placeholder rendering:** the UI subscribes to the aggregate Awareness state; any record ID held by an agent renders as the shimmer placeholder with that agent's avatar, sourced directly from the Awareness entry's `actor` field.
