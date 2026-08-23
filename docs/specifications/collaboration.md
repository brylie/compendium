# Presence and holds

**Depends on:** [`data-model.md`](./data-model.md) §2 (Yjs mapping)

---

Built on Yjs Awareness, not a custom channel. Yjs ships an **Awareness** protocol specifically for ephemeral, per-client state that isn't part of document content: cursor position, online status, and similar — it doesn't get persisted or CRDT-merged, and it auto-clears when a client disconnects. That's exactly the shape the PRD's hold mechanism needs, so holds are built on it rather than as a separate custom protocol:

- Each connected client (browser tab or MCP session) publishes an Awareness state: `{ actor: ActorId, heldRecordIds: string[] }`.
- **Human cursor presence → implicit hold:** the browser UI updates its own Awareness state's `heldRecordIds` to `[currentBlockId]` whenever the cursor moves, debounced ~1.5s on move-away (per PRD).
- **Agent hold request:** the MCP server's `hold_records` tool handler checks the _aggregate_ Awareness state across all connected clients for each requested record ID. A record already present in another client's `heldRecordIds` is denied for this request; everything else is granted. This directly implements the PRD's per-record (not all-or-nothing) acceptance criterion.
- **TTL:** Awareness states carry Yjs's built-in timeout (clears automatically if a client stops sending heartbeats) — this gives the 90–120s auto-release for free rather than needing custom expiry logic.
- **Placeholder rendering:** the UI subscribes to the aggregate Awareness state; any record ID held by an agent renders as the shimmer placeholder with that agent's avatar, sourced directly from the Awareness entry's `actor` field.
