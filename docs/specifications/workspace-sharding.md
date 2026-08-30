# Workspace catalog and CRDT sharding

**Status:** Proposed — requires the capacity baseline from #31 before approval.

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
  rows. It is the initial unit; #31 determines whether a later row partition is
  needed and under which measured conditions.
- The browser uses a small server-sent-events feed for catalog changes. SSE
  delivers invalidations; it never becomes a second source of truth or a
  replacement for collaborative content sync.
- Yjs WebSocket and Awareness connections are scoped to the explicitly opened
  Document or Collection shard.

This is intentionally a proposed decision, not an implementation commitment.
#31 must establish the Phase-0 baseline and identify whether a one-Y.Doc-per
Document/Collection design meets the expected operating envelope. The approval
record for #112 must state which assumptions survived that measurement.

## 2. Terms and boundaries

| Term                | Meaning                                                                                                                     | Authority                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Deployment instance | One locally configured Compendium process and database target. It separates dogfooding, development, and test environments. | Server configuration; see #111.                      |
| Workspace           | The top-level durable knowledge environment within a deployment instance.                                                   | Server-authorized request context.                   |
| Space               | An organizational and permission boundary within one Workspace. A person switches Spaces to work on different projects.     | Workspace catalog.                                   |
| Catalog             | The SQLite metadata projection needed to route, list, search, and authorize content without opening every content shard.    | Catalog service and committed database transactions. |
| Content shard       | The Y.Doc for one Document or Collection.                                                                                   | Authorized Yjs and service-layer mutations.          |

A deployment instance is not a Workspace, and a Space is not a tenant. This
keeps local operational isolation (#111), single-user multi-space organization
(#6), and eventual multi-user authentication (#3) independently evolvable.

## 3. Ownership model

### 3.1 Workspace catalog

The catalog is the authoritative location for the metadata required to navigate
and authorize a Workspace without subscribing to its content shards:

- Workspace and Space identities, titles, ordering, and membership.
- Document and Collection identities, titles, owning Space, hierarchy/order,
  and shard locator.
- Space-level access grants and the derived scopes assigned to access tokens.
- Catalog revision and committed event records.

Document titles and hierarchy are catalog fields. They are not duplicated into a
Document Y.Doc and derived later, because the sidebar needs them before opening
the Document. Record IDs remain stable global identities; a title is never an
identity or authorization key.

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

SSE is driven by the committed catalog write, never by the periodic persistence
of a Y.Doc snapshot. A snapshot callback would be delayed, might batch unrelated
content changes, and cannot safely identify which navigation metadata changed.

The SSE endpoint emits compact invalidations, for example:

```text
id: 184
event: catalog-changed
data: {"workspaceId":"…","revision":184,"documents":["…"],"spaces":["…"]}
```

The client treats this event as a hint to fetch authoritative catalog state. It
does not mutate its catalog cache solely from event payload. On reconnect, the
client supplies `Last-Event-ID` (or a known revision); if retained events no
longer cover that revision, the server sends a resync signal and the client
reloads the authorized catalog snapshot.

An SSE subscriber is authorized for a Workspace and a set of Spaces before it
is registered. Filtering happens before an event is emitted, not after it
reaches the browser. A permission revocation closes or resynchronizes affected
subscriptions immediately.

For the initial single-process deployment, an in-process publisher may drain
committed outbox rows immediately. Multiple application processes require a
shared outbox consumer/event backplane and shard ownership; independent mutable
in-memory replicas are invalid.

## 5. Trusted routing

Every boundary resolves a server-authorized context before reading or mutating
state:

| Boundary                  | Required context                                                 | Result                                       |
| ------------------------- | ---------------------------------------------------------------- | -------------------------------------------- |
| Page load and catalog API | deployment instance, Workspace, authorized Spaces                | Catalog snapshot or a scoped subset.         |
| Yjs WebSocket upgrade     | deployment instance, Workspace, content shard, caller scope      | One authorized Document or Collection Y.Doc. |
| SSE connection            | deployment instance, Workspace, authorized Spaces, last revision | Scoped catalog invalidations.                |
| MCP tool                  | token-derived Workspace and Space scope, target shard            | Authorized catalog or content operation.     |
| Persistence and audit     | Workspace, Space where applicable, shard                         | Independently keyed durable state.           |

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
later Yjs snapshot. Operations that change both catalog and content must define
their recovery protocol explicitly: record an operation ID, make retries
idempotent, and recover on restart from the catalog operation/outbox state plus
the relevant shard snapshot. Deleting or moving a Document must not publish its
catalog event until its required durable transition is complete.

Each shard supports lazy loading and flushing. It may unload only when it has no
authorized live connections, no active holds requiring it, and no unflushed
state. The catalog remains small and resident enough to route requests and
serve the sidebar without opening content shards.

## 7. Migration

The Phase-0 workspace migrates into one Workspace with one default Space. The
migration preserves:

- Document, Collection, record, and relation IDs.
- Document hierarchy and order.
- Collection schema, rows, and embedded-view references.
- Token grants, actor attribution, audit history, and snapshot recovery data.

Migration is versioned, idempotent, observable, and tested against a copied
representative database. A failed migration leaves the original recovery unit
intact and never partially exposes a catalog that points to unavailable shards.

## 8. Measurements that decide approval

#31 must record, for a representative seeded workspace and realistic concurrent
browser/MCP workload:

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
- UI and MCP operations enforce the same catalog, Space, and shard scope.
- A cross-document agent hold works only for records the caller can access and
  does not expose active editing state outside the relevant shard.
- Existing data migrates losslessly into the default Space and survives restart.
- Two local deployment instances remain isolated even when they run the same
  Compendium version concurrently.
