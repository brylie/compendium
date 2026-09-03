# Compendium review lenses

Use the sections relevant to the changed paths and behavior. These are prompts for investigation, not a demand to manufacture a finding in every category.

## Contents

1. Shared model and state authority
2. Service ownership and dependency direction
3. Workspace, Space, and shard isolation
4. UI/MCP/API parity
5. Blocks, rich text, links, and Markdown
6. Collection schema and views
7. Collaboration, holds, and undo
8. Audit, permissions, and tokens
9. Persistence and migrations
10. UI, accessibility, and design system
11. Testing and capacity gates

## 1. Shared model and state authority

Read `docs/specifications/data-model.md` and `architecture.md` when the PR changes entities, metadata, records, routes, or synchronization.

- A paragraph, Document block, Collection row, Board card, and Calendar entry remain the same `WorkspaceRecord` primitive; do not introduce modality-specific copies or identities.
- A Collection View is a non-owning projection/configuration over source records. Filtering, grouping, sorting, summaries, and layout must not copy or fork records.
- Identify the authority for every changed field: resource Y.Doc, server catalog, SQLite table, Awareness, or derived projection. Flag two writable authorities without an explicit synchronization/repair contract.
- Check create/read/update/delete, search, move/reorder, link resolution, audit, and migration implications for a new discriminator or field.

Useful searches: the field/type name; `WorkspaceRecord`; serialization reads and writes in `src/lib/data`; Drizzle schema; catalog projections; MCP Zod schemas; component switches.

## 2. Service ownership and dependency direction

Read `service-layer.md` and `service-layer-manifest.md` for route, MCP, service, or write-path changes.

- `src/lib/data` owns policy-free CRDT mechanics.
- `src/lib/services` owns a use case's permission check, mutation, audit entry, and required side effects in one place.
- SvelteKit and MCP handlers parse/validate, call the use case, and format the response; they must not recreate business logic or call `logAudit`/low-level mutations for server-mediated operations.
- Browser-direct Yjs editing is intentional for live collaboration, but its observer/projection contract must remain explicit and tested.
- Dependencies should point inward. Application services should not return MCP DTOs or import presentation-specific Markdown merely because MCP is the first consumer.
- Check the service manifest against actual modules and actual adapters. A declaration such as `ui: true` is not proof that a UI route calls it.

Search unchanged sibling routes and handlers for copies whenever one adapter changes.

## 3. Workspace, Space, and shard isolation

Read `workspace-sharding.md`, `architecture.md`, `persistence.md`, and the capacity baseline when routing or storage is touched.

- Resolve workspace/shard state through the server-owned request/resource context. Client-provided workspace IDs, Space IDs, resource IDs, room names, and URL params are selectors, not authority.
- Do not assume `resourceId === shardId`; legacy content can resolve to the default shard.
- Documents and Collections live in per-resource shards; cross-resource metadata comes from the catalog, not whichever Y.Doc happens to be open.
- A specific-Space read must not include uncataloged/default fallback content unless the specification explicitly classifies it there.
- WebSocket, MCP, SvelteKit loads/actions, search, audit, persistence, migration, and tests must resolve the same authoritative context.
- Check reconnect, idle unload, shutdown flush, snapshot reload, and two-instance isolation when lifecycle behavior changes.

## 4. UI/MCP/API parity

Read `mcp-tools.md`, relevant UI specs, and any public route contract.

For each changed domain operation, compare:

| Concern                       | UI  | MCP | HTTP/API | Migration/import |
| ----------------------------- | --- | --- | -------- | ---------------- |
| Input/runtime validation      |     |     |          |                  |
| Permission scope              |     |     |          |                  |
| Mutation owner                |     |     |          |                  |
| Audit action/actor            |     |     |          |                  |
| Output/read projection        |     |     |          |                  |
| Independent-client visibility |     |     |          |                  |
| Error/deleted/stale behavior  |     |     |          |                  |

Differences can be intentional, but they must be explicit. Look especially for manually duplicated enums/Zod schemas, ignored inputs, UI-only metadata writes, MCP read-only fields, and adapters returning subtly different defaults.

## 5. Blocks, rich text, links, and Markdown

Read `block-capability-contract.md`, `markdown-transcoding.md`, `internal-links.md`, and `rich-text-toolbar.md` for block/editor changes.

- Rich text remains native `Y.Text` formatting ranges; `RichText.runs` is derived, never independently stored.
- Block-level editing, holds, ordering, attribution, and undo remain aligned at record granularity.
- A new or changed block type needs storage/serialization, renderer, insertion/discovery, editing semantics, MCP read/write decision, Markdown representation, deleted/broken state, accessibility, and tests.
- ID-backed links remain rename-safe. Title lookup must handle duplicates deliberately and must not expose an inaccessible target through title, kind, schema, existence, or distinct error messages.
- Computed blocks such as table of contents and child pages derive their output; they do not persist copied outlines.

## 6. Collection schema and views

Read `collection-views.md` for Collection or Table/Board/Calendar changes.

- Table, Board, Calendar, full-page and embedded renderers use common schema mutation and projection semantics.
- Property changes handle existing row values, invalid conversions, deleted options, relation targets, primary fields, view configs, and summaries consistently.
- Select options preserve unique-label validation, stable IDs, configured ordering, and palette assignment across every surface.
- Concurrent changes to independent `viewConfig` members must merge independently; avoid whole-object last-writer-wins replacements for partial edits.
- Layout-specific interactions update source records or view configuration, never a renderer-specific copy.

## 7. Collaboration, holds, and undo

Read `collaboration.md` and `undo-redo.md` for Yjs transaction, Awareness, presence, or editing changes.

- Human cursor presence is an implicit hold; agent holds are explicit, advisory, per-record, shard-aware, and independently grantable/deniable.
- Awareness is ephemeral and must not become persisted domain state.
- Agent hold TTL and y-protocols stale-client cleanup are distinct timers.
- Writes requiring a hold validate it against the same shard/record and release it under the documented conditions.
- Undo is local/per-actor and should not undo remote collaborators' work; transaction origins and UndoManager scope matter.
- Test races, reconnects, abandoned holds, cross-shard batches, and remote deletion while editing when relevant.

## 8. Audit, permissions, and tokens

Read `audit-coverage.md`, `mcp-tools.md`, and `service-layer.md` for trust-sensitive work.

- Check authorization before reading sensitive state or mutating any target. List/search results are filtered, not post-redacted.
- Denied agent attempts are audited without leaking facts the caller did not already supply.
- Successful writes are audited exactly once with the correct actor and action; UI-direct and service-mediated paths must not omit or duplicate events.
- Token grants persist across an independent next request; do not mutate only an in-memory request object.
- Token-management choices come from shard-aware workspace reads, and submitted IDs are revalidated server-side.
- Never log or return bearer tokens after their intended one-time reveal.

Treat changes in these areas as requiring Tier A coverage.

## 9. Persistence and migrations

Read `persistence.md` and relevant Drizzle migrations.

- Yjs snapshots are keyed by workspace and shard and load before observers that would misclassify replay as a user edit.
- Catalog/SQLite projections are not a second writable truth. Check idempotency, ordering, crash windows, compensation, and restart repair where Yjs plus SQLite are both written.
- Schema changes include a generated migration and compatibility path for existing databases.
- Yjs schema changes preserve old snapshots and avoid destructive eager rewrites unless explicitly designed.
- Migration is restartable, bounded, and does not silently duplicate IDs, attribution, hierarchy, relations, or audit effects.

## 10. UI, accessibility, and design system

Read `design-system.md` plus the relevant interaction spec.

- Reuse shared components and tokens across full-page and embedded surfaces.
- Check keyboard operation, focus restoration/trapping, semantic roles/names, live announcements, empty/loading/error/deleted states, mobile layout, and both themes.
- Collaborative state must be perceivable without color alone.
- Do not demand identical UI for UI and MCP; demand consistent domain results and explicit capability differences.

## 11. Testing and capacity gates

Read `e2e-testing.md`; use the repository `quality-assurance` skill when deeper test selection or adversarial validation is needed.

- Unit/service tests prove isolated mechanics and complete side effects.
- Component tests prove rendered interaction logic.
- Tier A uses independent real MCP and WebSocket clients for permission, grant, hold, attribution, routing, and convergence behavior.
- Tier B is reserved for behavior that genuinely requires a browser DOM.
- A bug fix should add the regression test at the layer that would have caught it.
- Shard routing, Yjs schema/sync, fan-out, snapshot, catalog/SSE, persistence, or compaction changes require the bounded capacity benchmark; larger structural changes require the documented large-profile comparison.
- Coverage thresholds are a floor. Inspect whether assertions exercise failure modes rather than merely executing lines.
