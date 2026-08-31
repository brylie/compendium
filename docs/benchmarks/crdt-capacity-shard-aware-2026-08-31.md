# CRDT capacity — shard-aware transport — 2026-08-31

Issue [#123](https://github.com/brylie/compendium/issues/123) (Phase E) re-runs
the [2026-08-30 baseline](./crdt-capacity-baseline-2026-08-30.md) against the
**real** shard-aware transport [#112](https://github.com/brylie/compendium/issues/112)'s
design led to: [#113](https://github.com/brylie/compendium/issues/113)/[#127](https://github.com/brylie/compendium/pull/127)/[#130](https://github.com/brylie/compendium/pull/130)
cut every Document and Collection over to its own real `Y.Doc` shard, and
[#132](https://github.com/brylie/compendium/issues/132) migrated pre-existing
content into that shape. The 2026-08-30 note explicitly flagged its own
numbers as "not... a shipped shard-aware transport result" and required a
re-run "with real document and collection routes before comparing end-to-end
shard transport bytes" — this is that re-run.

## Method

`tests/benchmark/workspace-capacity.test.ts` was rewritten for this issue:
the previous version seeded every Document/Collection directly into the
single shared default `Y.Doc` and measured that doc's own sync/fan-out
behavior, which — despite #113/#132 having since shipped — would have kept
reproducing the Phase-0 global-workspace numbers, not a real shard-aware
result. The fixture now seeds through the actual service layer
(`serviceModules.documents.createDocument`, `.records.createRecord`,
`.collections.createCollection`), the same code path a production
`create_document`/`create_record`/`create_collection` MCP call uses — so
every Document and Collection created gets its own genuine shard, exactly as
in production.

For a small deterministic sample of shards (first/middle/last, so a `large`-scale
report stays readable rather than listing all 128), it measures:

- per-shard encoded `Y.Doc` state size;
- cold-load bytes/time for a client connecting to **one shard's own room**
  (`shard-<id>`) — "opening one document," not "loading the whole workspace";
- fan-out bytes to a same-shard peer **and** to a different-shard peer for the
  same edit — cross-shard isolation is asserted as a hard `0` at every
  profile, not just reported as a number;
- MCP `hold_records`+`write_record` round-trip latency, spread across many
  different Document shards rather than repeated calls against one document;
- catalog (`catalog_documents`/`catalog_collections`/`record_locator`) row
  counts and estimated serialized size;
- `catalog_outbox` row count and average/total payload size — the closest
  available proxy for a future SSE catalog-refresh frame, since **no SSE
  consumer exists yet** ([#121](https://github.com/brylie/compendium/issues/121),
  Phase C) — labeled as a proxy, not a real transport measurement;
- aggregate snapshot bytes across every resolved shard, and restart/reload
  time for the sampled shards only (nothing eagerly reloads every shard —
  [#122](https://github.com/brylie/compendium/issues/122)'s lazy-load design);
- process heap delta, CPU time, and event-loop-delay p99 across the whole run.

**SSE reconnect/resync behavior (§8/§9) is explicitly not measured here** —
it requires #121 to exist first. This is a deliberate, documented scope
limit, not an oversight.

Both profiles ran with `disableBc: true` on every benchmark client, same as
the 2026-08-30 baseline, so all reported bytes cross the real WebSocket
transport.

```sh
npm run benchmark:workspace        # daily
npm run benchmark:workspace:large  # large
```

## Results

| Metric                                              | Daily: 12 docs, 3 collections / 40 rows | Large: 120 docs, 8 collections / 400 rows |
| --------------------------------------------------- | --------------------------------------: | ----------------------------------------: |
| Per-shard state — Document (sampled)                |                             ~7.4–7.5 KB |                                  ~11.1 KB |
| Per-shard state — Collection (sampled)              |                           ~18.4–18.8 KB |                                 ~187.7 KB |
| Cold load — bytes per shard (one client, one shard) |                                 7,471 B |                                  11,154 B |
| Cold load — elapsed (3 sampled shards)              |                                 26.4 ms |                                   82.9 ms |
| Fan-out — same-shard peer receives                  |                                    52 B |                                      52 B |
| Fan-out — different-shard peer receives             |                                 **0 B** |                                   **0 B** |
| MCP write p50 / p95                                 |                            4.1 / 6.2 ms |                              3.6 / 7.3 ms |
| Catalog rows (documents / collections / locator)    |                            12 / 3 / 327 |                           120 / 8 / 6,208 |
| Catalog estimated size                              |                                62,334 B |                               1,153,772 B |
| Outbox rows / avg payload (proxy only, no SSE)      |                               15 / 53 B |                                128 / 53 B |
| Aggregate snapshot bytes, all shards                |                               145,882 B |                               2,839,930 B |
| Restart — ms per sampled shard                      |                                 1.89 ms |                                   2.93 ms |
| Process heap delta                                  |                                 43.4 MB |                                  124.4 MB |
| Event-loop p99                                      |                                20.74 ms |                                  16.06 ms |

## Interpretation

**The headline number**: at `large` scale, a client opening _one_ document
now transfers **11,154 B**. Before sharding, opening any page meant syncing
the entire global workspace state — **2,848,008 B**, per the 2026-08-30
baseline. That's roughly a **99.6% reduction** in what a single client
actually needs to download to view one page — the exact blast-radius problem
Issue #112's design set out to fix, now measured against the real
implementation rather than projected from a same-shape single-document
extract.

Process cost improved just as sharply at `large` scale: heap delta dropped
from 518.9 MB to 124.4 MB, and event-loop p99 from 417.07 ms to 16.06 ms —
because the benchmark's own Node process now does many small per-shard Yjs
operations instead of repeatedly encoding/transacting one enormous `Y.Doc`.

Total _persisted_ bytes didn't shrink (2,839,930 B across 128 shards here vs.
2,852,778 B in one blob before) — expected, since it's fundamentally the same
content, just partitioned. The win isn't storage footprint; it's that no
single client, sync, or in-memory operation touches all of it at once anymore.

Cross-shard isolation held at **exactly 0 bytes** leaked to a different
shard's client, at both profile scales — not just a correctness assertion
elsewhere in the test suite, but confirmed as part of the transport-cost
measurement itself.

## §10 deferred items — resolved

Per `workspace-sharding.md` §10, this issue resolves the items explicitly
deferred at #112's approval:

- **Collection row-partition threshold**: not required at measured scale.
  The largest sampled Collection shard (400 rows) encoded to ~187.7 KB — well
  under any single-shard escalation concern. No partition rule is needed for
  Collections up to this size; revisit if a real Collection's row count grows
  an order of magnitude beyond 400.
- **Event-retention window** (`catalog_outbox`): **not fully resolved** —
  genuinely blocked on #121 building a real SSE consumer to validate a
  retention policy against. This run's outbox growth-rate data point (128
  create events → 6,800 B total payload at `large` scale) is a sizing input
  for that future decision, not a threshold decision on its own.
- **Snapshot cadence**: the existing 30s (`SAVE_INTERVAL_MS`) cadence holds
  comfortably at measured scale — 2.84 MB aggregate across 128 shards is a
  trivial per-tick write cost split across that many independent contexts, no
  single shard's snapshot is large, and idle-unload (#122) already bounds how
  many stay resident. No cadence change needed at this scale. This
  conclusion is based on aggregate snapshot _size_; the benchmark calls
  `flush()` once, deliberately, to measure it — it does not separately
  measure the periodic `flushContext` write's own I/O or event-loop cost as
  the 30s timer fires repeatedly over a long-running process.
- **Does Document/Collection shard granularity hold at measured scale?**
  **Yes.** Cross-shard isolation held exactly, per-shard state stayed small
  even at `large` scale's heaviest Collection, and process resource cost
  improved by roughly an order of magnitude over the pre-sharding baseline
  rather than degrading. No basis to reopen the granularity decision at this
  scale.

## Gates and follow-ups

- Keep the `daily` profile in CI; its guardrails were reset from this run's
  real numbers (not guessed): per-shard cold-load bytes < 30 KB, cold-load
  time < 1 s, MCP write p95 < 1.5 s, restart < 100 ms/shard — each with
  multiple times measured headroom. Cross-shard isolation (`0` bytes to a
  different shard) is asserted at every profile, not just `daily`.
- SSE reconnect/resync behavior (§8/§9) remains unmeasured until #121 ships;
  re-run this benchmark's outbox/catalog-refresh section once a real SSE
  consumer exists, rather than treating the proxy numbers here as final.
- Browser-heap collection remains a follow-up (unchanged from the
  2026-08-30 note) — this benchmark's heap figure is the Node host running
  simulated Yjs clients, not a browser DevTools snapshot.
