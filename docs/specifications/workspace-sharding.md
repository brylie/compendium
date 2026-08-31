# Workspace catalog and CRDT sharding

**Status:** Approved (2026-08-30) — the catalog/content-shard boundary,
ownership model, trusted-routing rules, committed-catalog-write/SSE contract,
and migration design in this document are the approved direction for #113
(implementation) and #114 (migration and isolation). Approval is conditional
per §8/§10: #113 must reproduce the required measurements with real
shard-aware transport before this boundary is treated as load-bearing, and
its results may still adjust the Collection partition threshold, event-
retention window, or snapshot cadence.

**Depends on:** [`prd.md`](../prd.md), [`architecture.md`](./architecture.md),
[`persistence.md`](./persistence.md), [`collaboration.md`](./collaboration.md),
and [`mcp-tools.md`](./mcp-tools.md)

**Tracked by:** #112 (design), #113 (implementation), #114 (migration and
isolation), and #6 (multi-space experience)

## 1. Decision to validate

Compendium uses CRDTs where several clients concurrently edit rich content,
not as the universal transport for every reactive interface element.

- A server-owned **workspace catalog** is durable SQLite state. It owns Spaces,
  document and Collection titles, hierarchy, membership, access scopes, and the
  current catalog revision.
- A **Document shard** is one Y.Doc containing one Document's ordered blocks
  and rich text.
- A **Collection shard** is one Y.Doc containing one Collection's schema and
  rows. It is the initial unit; a later row partition requires a measured
  threshold and a separate design decision.
- The browser uses a small server-sent-events feed for catalog changes. SSE
  delivers invalidations; it never becomes a second source of truth or a
  replacement for collaborative content sync.
- Yjs WebSocket and Awareness connections are scoped to the explicitly opened
  Document or Collection shard.

This is the approved architecture direction, not yet an implementation
commitment. The completed [#31 capacity baseline](../benchmarks/crdt-capacity-baseline-2026-08-30.md)
supports a small daily Phase-0 workspace and establishes a global-state
escalation boundary. Its document-size projection supports this shard direction,
but does not substitute for real shard-aware transport measurements. §10
records which assumptions survived that measurement and which #113 must still
prove.

## 2. Terms and boundaries

| Term                | Meaning                                                                                                                                                   | Authority                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Deployment instance | Server-owned instance identity, persistence target, and event scope. One or more coordinated processes with all three values belong to the same instance. | Server configuration; see #111.                      |
| Workspace           | The top-level durable knowledge environment within a deployment instance.                                                                                 | Server-authorized request context.                   |
| Space               | An organizational and permission boundary within one Workspace. A person switches Spaces to work on different projects.                                   | Workspace catalog.                                   |
| Catalog             | The SQLite metadata projection needed to route, list, search, and authorize content without opening every content shard.                                  | Catalog service and committed database transactions. |
| Content shard       | The Y.Doc for one Document or Collection.                                                                                                                 | Authorized Yjs and service-layer mutations.          |

A deployment instance is not a Workspace, and a Space is not a tenant. This
keeps local operational isolation (#111), single-user multi-space organization
(#6), and eventual multi-user authentication (#3) independently evolvable.

Phase 0 and the first #113 implementation run one application process per
Deployment instance. Starting independent processes against the same instance
identity and SQLite target is unsupported until the coordination contract below
is implemented; separate personal, development, and test instances must use
distinct server-owned identities and persistence targets. A future scale-out
deployment still represents one Deployment instance only when every process
shares the same identity, catalog/outbox database, authorization policy, and
event backplane. It must use durable shard ownership leases, transactional
outbox claims, and a deployment-scoped event backplane; independent mutable
in-memory replicas are invalid. #111 owns the startup diagnostics and isolation
tests, while #113 must not silently introduce a second writer.

## 3. Ownership model

### 3.1 Workspace catalog

The catalog is the authoritative location for the metadata required to navigate
and authorize a Workspace without subscribing to its content shards:

- Workspace and Space identities, titles, ordering, and membership.
- Document and Collection identities, titles, owning Space, hierarchy/order,
  and shard locator.
- Space-level access grants and the derived scopes assigned to access tokens.
- A workspace-wide record locator with a unique `(workspace_id, record_id)`
  key, owning-shard locator, and record kind.
- Catalog revision and committed event records.

Document titles and hierarchy are catalog fields. They are not duplicated into a
Document Y.Doc and derived later, because the sidebar needs them before opening
the Document. Record IDs remain stable global identities; a title is never an
identity or authorization key. Creating a record reserves its supplied or
generated ID in the workspace-wide locator transaction before inserting it into
the target shard. A duplicate `(workspace_id, record_id)` is rejected; a retry
with the same operation ID returns its original result rather than creating a
second record. The hold coordinator resolves this locator before using its
`(workspaceId, recordId)` key, so a hold cannot conflate records in different
shards.

The existing `snapshots`, `access_tokens`, and `audit_log` storage must become
explicitly scoped by Workspace and, where applicable, Space and shard. A
catalog migration must preserve existing IDs and create one default Space for
the current single-space workspace.

### 3.2 Document and Collection shards

A Document shard owns its block records, their order, Y.Text content, and the
rich-content collaboration state for that Document. A Collection shard owns its
schema, rows, and Collection-view source data. A content shard does not own its
title, parent hierarchy, or Space membership.

Relations, page links, and collection-view references remain ID-backed. A
cross-Space reference is valid only when the caller's permission scope permits
both sides; rendering and search must not use a catalog lookup to reveal an
inaccessible target's title.

### 3.3 Ephemeral coordination

Awareness belongs to the active content shard: cursors, active editing state,
and visual agent placeholders must not broadcast to clients outside that shard.

The server retains a workspace-scoped, ephemeral hold coordinator keyed by
`workspaceId` and record ID. It aggregates the active shard Awareness state
needed to decide an MCP `hold_records` request, while projects only the result
into shards whose authorized clients need to render it. This preserves a
cross-document agent batch without leaking cursor or presence state to an
unrelated Space.

## 4. Committed catalog writes and SSE

Catalog mutations use one service-layer transaction:

```text
authorize caller and target scope
  → update catalog rows
  → increment workspace catalog revision
  → append catalog outbox event and audit entry
  → commit SQLite transaction
  → publish the committed event to active SSE subscribers
```

Operations that also move, create, or delete content use a durable operation
row rather than publishing directly from the initial catalog transaction:

```text
pending_content → content_durable → publishable → published
```

The initial catalog transaction records the operation ID, affected shards,
hidden desired catalog state, and a non-publishable outbox row. It does not
allocate a public catalog revision or alter the published catalog projection.
The shard transition writes the operation ID into its durable
snapshot/recovery marker; only then does one transaction promote the desired
state into the published catalog, allocate the next public Workspace revision,
and mark its outbox row `publishable`. An outbox consumer may claim and emit
only `publishable` rows.

Page loads, catalog APIs, MCP routing reads, and SSE all use the published
catalog projection only. While an operation is `pending_content`, a create and
its reserved record IDs are unrouteable; a move continues to serve its previous
published locator/hierarchy; and a delete continues to serve its previous
published state. A failed or recovered operation either promotes atomically or
leaves that prior public state intact. Restart recovery resumes a pending
operation idempotently by inspecting durable markers, never by assuming an
internal catalog intent proves the content transition completed. This prevents a
client from being routed to absent or stale content.

Public revisions are allocated only at that promotion transaction and are
strictly ordered per Workspace. An outbox consumer delivers a contiguous prefix
of publishable public revisions; it cannot advance a stream past an earlier
unresolved operation. If durable recovery cannot provide that prefix, the
consumer emits `catalog-resync` rather than advancing a cursor across the gap.

SSE is driven by the committed catalog write, never by the periodic persistence
of a Y.Doc snapshot. A snapshot callback would be delayed, might batch unrelated
content changes, and cannot safely identify which navigation metadata changed.

The SSE endpoint emits compact invalidations, for example:

```text
id: opaque-authorized-stream-cursor
event: catalog-changed
data: {"documents":["…"],"spaces":["…"]}
```

The client treats this event as a hint to fetch authoritative catalog state. It
does not mutate its catalog cache solely from event payload. On reconnect, the
client supplies an opaque `Last-Event-ID` cursor. The cursor is scoped to the
Deployment instance, Workspace, and an authorization-scope fingerprint; it
maps server-side to the highest catalog revision delivered to that authorized
stream, but never exposes a raw workspace revision or event ID. If the scope
has changed, the cursor fails validation, retained source events no longer
cover its hidden revision, or filtering makes replay coverage ambiguous, the
server sends `catalog-resync` and the client reloads the authorized catalog
snapshot. Inaccessible Space changes therefore create neither an observable
cursor gap nor an existence signal.

An SSE subscriber is authorized for a Workspace and a set of Spaces before it
is registered. Filtering happens before an event is emitted, not after it
reaches the browser. A permission revocation closes or resynchronizes affected
subscriptions immediately. A move or permission change that crosses an
authorization boundary sends a generic `catalog-resync` to subscribers whose
authorized catalog may lose or gain the entry. That signal contains no Document
ID, destination Space, title, hierarchy, or inaccessible metadata; the
subscriber reloads its authorized catalog snapshot to remove or add entries.

For the initial single-process deployment, an in-process publisher may drain
only `publishable` outbox rows immediately. Multiple application processes
require the deployment coordination rules in §2; independent mutable in-memory
replicas are invalid.

## 5. Trusted routing

Every boundary resolves a server-authorized context before reading or mutating
state:

| Boundary                  | Required context                                                 | Result                                         |
| ------------------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| Page load and catalog API | deployment instance, Workspace, authorized Spaces                | Published catalog snapshot or a scoped subset. |
| Yjs WebSocket upgrade     | deployment instance, Workspace, content shard, caller scope      | One authorized Document or Collection Y.Doc.   |
| SSE connection            | deployment instance, Workspace, authorized Spaces, last revision | Scoped catalog invalidations.                  |
| MCP tool                  | token-derived Workspace and Space scope, target shard            | Authorized catalog or content operation.       |
| Persistence and audit     | Workspace, Space where applicable, shard                         | Independently keyed durable state.             |

Path segments, query values, and Yjs room names are selectors only. They may
choose among contexts the server has already authorized for that caller, but
they never grant authority. The browser receives its bootstrap configuration
from the server; it does not invent a Workspace identity.

## 6. Persistence and recovery

Catalog writes are immediately transactional SQLite writes. Yjs content retains
its CRDT-first write path and is persisted as shard-scoped snapshots, with the
update-log versus periodic-snapshot decision revisited from #31's recovery and
write-churn measurements.

There is no false atomicity claim between a catalog transaction and an arbitrary
later Yjs snapshot. Operations that change both catalog and content use the
durable operation state in §4: record an operation ID, make retries idempotent,
persist a shard completion marker, and recover on restart from the operation,
outbox, and relevant shard snapshot. Deleting or moving a Document must not
publish its catalog event until its required durable transition is complete.

Each shard supports lazy loading and flushing. It may unload only when it has no
authorized live connections, no active holds requiring it, and no unflushed
state. The catalog remains small and resident enough to route requests and
serve the sidebar without opening content shards.

## 7. Migration

The Phase-0 workspace migrates into one Workspace with one default Space. A
versioned migration first loads the legacy snapshot into an isolated Y.Doc and
records a manifest keyed by `(legacy_snapshot_id, migration_version)`. It then
deterministically creates:

- one catalog row and Document shard for each legacy Document, with its ordered
  block records and Y.Text content;
- one catalog row and Collection shard for each legacy Collection, with its
  schema and rows; and
- workspace-wide record-locator entries for every migrated block and row.

The migration copies IDs exactly: `parentId`, record order, relation targets,
page-link targets, and collection-view references retain their original IDs and
are resolved only after the corresponding target locator exists. Each target
shard is snapshotted with the migration operation ID and content checksum before
the manifest records it durable. The catalog exposes the new workspace only
after every planned target has a durable marker and the locator manifest is
complete. Re-running a migration reuses verified targets from that manifest and
creates no duplicate rows, records, or snapshots.

The original mixed Y.Doc snapshot and its audit/recovery metadata remain a
read-only legacy recovery unit until all target checksums, IDs, references,
token grants, and restart recovery checks pass and an explicit retention policy
permits removal. A failed migration leaves that unit intact and does not expose
a partial catalog. The migration preserves:

- Document, Collection, record, and relation IDs.
- Document hierarchy and order.
- Collection schema, rows, and embedded-view references.
- Token grants, actor attribution, audit history, and snapshot recovery data.

Migration is versioned, idempotent, observable, and tested against a copied
representative database.

## 8. Measurements that decide approval

The completed #31 baseline records the Phase-0 global-workspace envelope. #113
must rerun a workspace seeded with representative data and a realistic
concurrent browser/MCP workload with real shards, recording:

- Per-Document and per-Collection encoded state size.
- Catalog size, catalog refresh payload, and SSE reconnect/resync behavior.
- Cold load, initial Yjs sync, update-apply latency, and fan-out bytes per
  active shard.
- Server/client memory, CPU, event-loop delay, snapshot/restart time, and
  recovery behavior.
- The cost of an all-Yjs navigation catalog compared with committed catalog
  writes plus SSE invalidation.

The approval decision must state whether the proposed Document/Collection
granularity is accepted, whether Collections need an initial partition rule,
the retained event window, snapshot cadence, and any measured thresholds that
require further partitioning or compaction.

## 9. Required verification

- A client connected to one content shard never receives another shard's Yjs
  updates or Awareness state.
- A Space-scoped SSE subscriber never receives an event that reveals an
  inaccessible title, hierarchy, or existence signal.
- A missed SSE event causes a revision-aware catalog resync, not a stale UI.
- Pending content operations are absent from routing reads; a move/delete
  retains its previous published state until its successor is durable.
- Public outbox delivery cannot advance an SSE cursor past an unresolved earlier
  Workspace operation; recovery produces a contiguous prefix or resync.
- An opaque SSE cursor cannot reveal an inaccessible Space change; a changed or
  ambiguous authorized scope causes a catalog resync.
- A move out of scope, move into scope, and permission change each trigger a
  generic scoped resync without naming an inaccessible target or destination.
- UI and MCP operations enforce the same catalog, Space, and shard scope.
- A cross-document agent hold works only for records the caller can access and
  does not expose active editing state outside the relevant shard.
- A duplicate caller-supplied record ID in two shards of one Workspace is
  rejected, while independent Workspaces remain isolated.
- Crash/restart recovery never emits a move/delete catalog event before its
  target shard transition is durable, and retries remain idempotent.
- Existing data migrates losslessly into the default Space and survives restart:
  fixtures cover mixed Documents/Collections, IDs, embedded views, links,
  recovery metadata, and a re-run after partial completion.
- #111 proves two local deployment instances remain isolated even when they run
  the same Compendium version concurrently; a later scale-out implementation
  proves lease, outbox-claim, and event-backplane coordination within one
  Deployment instance.

## 10. Approval decision (recorded 2026-08-30)

Approved for #113/#114 to build against, on the completed #31 baseline and
the contracts specified above:

- The catalog/content-shard split in §1–§3: a durable SQLite workspace
  catalog owning Space, Document, and Collection identity/title/hierarchy/
  scope, separate from one Y.Doc per Document and one Y.Doc per Collection.
- The trusted-routing rule in §5: every boundary (page load, WebSocket
  upgrade, SSE, MCP, persistence) resolves a server-authorized Workspace/
  Space/shard context; a client-supplied selector is never authority.
- The committed-catalog-write/durable-operation/SSE contract in §4, including
  the `pending_content → content_durable → publishable → published` state
  machine, the public-revision/outbox-cursor ordering guarantees, and the
  `catalog-resync` behavior for scope changes and cursor gaps.
- The migration design in §7: versioned, idempotent, checksum-verified,
  ID-preserving migration of the current single-space workspace into one
  default Space, with the original snapshot retained read-only until
  verification passes.
- The deployment-ownership and coordination rules in §2: one process per
  Deployment instance today; a future scale-out deployment requires durable
  shard-ownership leases, transactional outbox claims, and a shared event
  backplane — independent mutable in-memory replicas are invalid.

Explicitly deferred, not settled by this approval:

- Where a **saved, shareable view configuration** (PRD P1) is addressed once
  it exists as its own catalog-navigable artifact rather than an embedded
  `collection_view` block's `viewConfig` (data-model.md §4) — out of scope
  here because the feature itself isn't built yet; #113 or a follow-up must
  extend §3.1's catalog fields to cover it before that feature lands.
- Storage-engine changes to `collaboration.md`'s aggregate-Awareness
  description — `data-model.md` §4 itself was updated once #113/#132 actually
  shipped per-shard `Y.Doc`s (see §11 below); `collaboration.md` still awaits
  its own equivalent pass.

## 11. Phase E measurement resolution (recorded 2026-08-31)

#123 re-ran §8's required measurements against the real shard-aware
transport #113/#127/#130/#132 shipped (not the #31 global-workspace
projection) — see the dated note
[`crdt-capacity-shard-aware-2026-08-31.md`](../benchmarks/crdt-capacity-shard-aware-2026-08-31.md)
for full method and results. This resolves the two items §10 deferred to
real measurement:

- **Collection row-partition threshold**: not required at measured scale. A
  400-row Collection shard encoded to ~187.7 KB — no partition rule needed;
  revisit only if a real Collection's row count grows an order of magnitude
  beyond that.
- **Snapshot cadence**: the existing 30s (`SAVE_INTERVAL_MS`) cadence holds
  comfortably — 2.84 MB aggregate across 128 sharded snapshots at `large`
  scale is a trivial per-tick cost split across that many independent,
  lazily-loaded (#122) contexts. No cadence change needed at this scale.
- **Event-retention window** (`catalog_outbox`): **not fully resolved** —
  genuinely blocked on #121 shipping a real SSE consumer to validate a
  retention policy against; this run's outbox growth-rate data point (128
  create events → 6,800 B total payload at `large` scale) is a sizing input
  for that future decision, not a threshold decision on its own.
- **Does Document/Collection shard granularity hold at measured scale?**
  **Yes** — cross-shard isolation held at exactly 0 bytes leaked in both
  profiles, a client opening one document at `large` scale now transfers
  ~11 KB versus the full 2.85 MB global state before sharding (~99.6%
  reduction), and process resource cost (heap, event-loop p99) improved by
  roughly an order of magnitude rather than degrading. No basis to reopen
  the granularity decision.

SSE reconnect/resync behavior (§8/§9) remains unmeasured, explicitly deferred
to #121 — not silently dropped from this resolution.
