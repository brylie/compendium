# CRDT capacity baseline — 2026-08-30

Issue [#31](https://github.com/brylie/compendium/issues/31) establishes a
measured baseline before the workspace catalog and shard design in [#112](https://github.com/brylie/compendium/issues/112)
is approved. This is deliberately a real transport benchmark: it uses the
application's temporary SQLite database, Yjs WebSocket endpoint, and MCP HTTP
server rather than measuring isolated Yjs objects only.

## Method

The benchmark seeds deterministic documents, blocks, collections, and rows;
then connects Yjs clients, performs a human-originated WebSocket mutation, and
runs sequential MCP `hold_records` and `write_record` calls. It captures:

- encoded global Yjs state and persisted snapshot sizes;
- initial client-sync bytes and elapsed time;
- receiver-side WebSocket bytes for one fan-out mutation;
- MCP write p50/p95 elapsed time;
- process heap delta, CPU time, and event-loop-delay p99;
- snapshot-backed context restart time and restored state size.

The bounded `daily` profile is suitable for CI. The `large` profile is a
manual regression check. Run them with:

```sh
npm run benchmark:workspace
npm run benchmark:workspace:large
```

The harness uses a fresh temporary database and random localhost port, so it
cannot read or modify a running daily workspace database.

## Results

Measurements were taken on 2026-08-30 in the local Node test environment.
They are a baseline and trend signal, not universal production SLOs.

| Metric                              | Daily: 12 docs, 192 blocks, 3 collections / 120 rows, 3 clients, 12 MCP writes | Large: 120 docs, 2,880 blocks, 8 collections / 3,200 rows, 8 clients, 80 MCP writes |
| ----------------------------------- | -----------------------------------------------------------------------------: | ----------------------------------------------------------------------------------: |
| Encoded global state                |                                                                      142,694 B |                                                                         2,848,008 B |
| Aggregate initial-sync bytes        |                                                                      142,776 B |                                                                         8,544,250 B |
| All-clients initial-sync elapsed    |                                                                        93.5 ms |                                                                            973.2 ms |
| Receiver fan-out bytes (one edit)   |                                                                          116 B |                                                                               406 B |
| Fan-out convergence elapsed         |                                                                        27.2 ms |                                                                             25.9 ms |
| MCP write p50 / p95                 |                                                                   5.5 / 8.4 ms |                                                                        4.9 / 9.0 ms |
| Persisted snapshot                  |                                                                      143,424 B |                                                                         2,852,778 B |
| Snapshot-backed restart             |                                                                         9.4 ms |                                                                            130.1 ms |
| Process heap delta                  |                                                                        25.3 MB |                                                                            396.1 MB |
| Event-loop p99                      |                                                                       43.94 ms |                                                                           270.01 ms |
| One-document shard state projection |                                                                        6,795 B |                                                                            10,147 B |

## Interpretation and decision boundary

The daily profile fits comfortably inside the initial CI guardrails: less than
2 MiB aggregate initial sync, less than 2 seconds initial sync and restart,
and less than 1.5 seconds MCP write p95. It is therefore safe to start using
Compendium for a small daily Tech with Brylie workspace while the workspace
work proceeds.

The large profile exposes the existing global-document cost: every new client
receives the whole 2.85 MB workspace state, and the one-process benchmark
showed a 396 MB heap increase with a 270 ms event-loop p99. A same-shape
single-document state is roughly 10 KB, which makes document-level Yjs shards
the appropriate next boundary. The catalog/SSE design in #112 keeps titles and
navigation outside that document state so unrelated document edits need not
grow client synchronization or CRDT fan-out.

This projection is intentionally not presented as a shipped shard-aware
transport result: current Phase 0 routing still resolves every connection to
the global shard. #113 must rerun these profiles with real document and
collection routes before comparing end-to-end shard transport bytes.

## Gates for the next implementation phase

- Keep the `daily` profile in CI with its current conservative limits.
- Treat a global snapshot at or above 2 MiB, event-loop p99 at or above 100 ms,
  or a daily CI guardrail failure as a trigger to prioritize sharding or
  compaction work rather than increasing the global-state envelope.
- #113 must report per-shard encoded state, sync bytes, apply latency, and
  receiver fan-out with two active document shards plus a collection shard.
- Browser heap remains a follow-up measurement: this benchmark's heap value is
  the Node host running simulated Yjs clients, not a browser DevTools heap
  snapshot. Add browser-memory collection when #24 establishes the user-facing
  sync-latency SLO.
