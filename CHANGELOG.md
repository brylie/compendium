# Changelog

All notable changes to Compendium will be documented in this file.

The project follows [Semantic Versioning](https://semver.org/). Git release
tags use the `vX.Y.Z` convention.

## [0.4.1] - 2026-09-12

### Fixed

- The MCP server advertised a hardcoded `0.1.0` identity to every connecting
  client regardless of the actual release version; it now reports the real
  package version.

[0.4.1]: https://github.com/brylie/compendium/releases/tag/v0.4.1

## [0.4.0] - 2026-09-12

The block editor rounds out toward feature-complete and Board/Calendar
configuration reaches GitHub-Projects-level depth: reordering, layout,
relations, swimlanes, and a record detail pane, all held to a WCAG 2.1 AA
accessibility bar. (File/image attachments remain deferred pending a
storage-backend decision.)

### Added

- Drag-and-drop block reordering, with a full keyboard equivalent.
- A categorized, searchable slash-command menu.
- A multi-column layout block with real nested containers.
- Callout blocks gain style presets plus a custom icon and color picker.
- A child-pages block that lists a Document's sub-pages live, Confluence-style.
- A relation property type: pick and display linked records from other
  Collections directly in Table, Board, and Calendar.
- Board swimlanes — an optional second grouping dimension, configurable by
  people and by MCP agents through `viewConfig`.
- A full-width display toggle for blocks.
- A block action menu, multi-select, and a List View document outline.
- Synced blocks now show their provenance and support a "detach" action to
  break the link deliberately.
- A record detail pane for Collections, opening a row's full record
  alongside the view.
- Backlinks now navigate to the exact referring block instead of just the
  containing document.
- Keyboard navigation between Document blocks (Arrow Up/Down), and a
  documented, native Tab/Shift+Tab focus order.
- Screen-reader announcements for held-block state changes and for live
  remote updates in Collection views, closing out a WCAG 2.1 AA accessibility
  pass across Table, Board, and Calendar.
- `viewConfig` is now stored as per-member Yjs entries, so concurrent edits
  to different settings (grouping, filter, sort) merge instead of one
  silently overwriting the other; MCP's `write_record` gets a matching
  `viewConfigPatch` for the same per-field merge.
- New records on a Select field get a sensible default option instead of
  starting blank; duplicate field labels within a Collection are now
  rejected.
- Documents and Collections with duplicate titles are now disambiguated in
  list and sidebar UIs.
- MCP access-token grant pickers, and write-path validation for
  `collection_view` blocks, now cover sharded Documents and Collections
  correctly.

### Fixed

- Board and Calendar no longer show a redundant duplicate title control
  when the primary field and the grouping field are the same; Calendar
  entries now render the primary field as an editable cell, matching Board.
- A checkbox used as a Collection's primary field displayed as "Untitled"
  instead of its checked/unchecked state.
- Board's groupBy columns could render empty after a fresh shard connection
  until an unrelated interaction nudged reactivity.
- Editable primary-field title cells and other property-value inputs had no
  accessible name for assistive technology.

[0.4.0]: https://github.com/brylie/compendium/releases/tag/v0.4.0

## [0.3.0] - 2026-09-01

Compendium moves from a single implicit workspace to explicit, isolated
Spaces: a server-owned instance identity anchors trust, a workspace catalog
and per-record CRDT shard boundary replace the single global document, and
existing content migrates across losslessly. People get a Space switcher and
space-nested routing in the UI; MCP agents get Space-scoped access tokens.

### Added

- Server-owned instance identity and a trusted request context, closing the
  gap where a client-supplied value could otherwise be mistaken for an
  authoritative workspace selector.
- A workspace catalog (Documents/Collections index) backing a per-record Y.Doc
  shard model, replacing the single global in-memory document — validated
  against a measured CRDT capacity baseline before cutover.
- Lossless migration of existing single-workspace content into the new
  catalog/shard model, with documented rollback and backup expectations.
- A Space switcher in the sidebar with full keyboard navigation (roving
  focus, wrap-around, Escape, focus return) and space-nested routing
  (`/space/[spaceId]/...`), including self-healing redirects away from
  unknown or cross-space URLs instead of leaking content.
- MCP access tokens can now be scoped to an allowlist of Spaces, in addition
  to their existing per-Document/Collection allowlist.

### Fixed

- Favicon links 404'd after navigating into a nested Space route (e.g.
  `doc/[id]`, `table/[id]`); `app.html`'s static asset links are no longer
  computed relative to route depth.
- The collapsed sidebar Space switcher had no discoverable accessible name
  for screen readers beyond a generic label; it now announces the active
  Space's name.
- CI's branch-coverage gate was silently non-functional (a missing
  `pipefail` let it report green regardless of the actual coverage result);
  the gate now genuinely enforces, and the underlying coverage shortfall
  (76.77% → 80.1% branches) has been closed with targeted tests.

[0.3.0]: https://github.com/brylie/compendium/releases/tag/v0.3.0

## [0.2.0] - 2026-08-30

Collection schema management grows up: fields and Select options now have a
full lifecycle, Board/Calendar get an explicit, user-controlled record
identity, and Select-driven sorting finally follows the workflow order
people actually configure.

### Added

- A first-class field manager for Collections — rename, retype, insert,
  duplicate, hide-in-view, and delete any field from a per-column menu or a
  collection-wide "Manage fields" dialog shared by Table, Board, and
  Calendar.
- Full lifecycle management for Select field options: add, rename, recolor,
  reorder (drag-and-drop or keyboard), and delete, with a small consistent
  color palette and a delete confirmation showing how many records are
  affected.
- An explicit, Collection-wide primary field controlling each record's title
  everywhere it's shown — Board and Calendar card titles now follow a
  deliberate choice (with a sensible automatic fallback) instead of always
  picking the first text-type field in schema order.
- Select fields sort by their configured option order (e.g. a workflow's
  Backlog → In Progress → Done sequence) in Table, Board, and Calendar,
  matching the order Board's own columns already used.

### Fixed

- Field-menu dropdowns no longer clip or overflow the viewport in dense
  tables, and the field manager dialog's own layout and stacking issues are
  resolved.
- The full-page Collection table view's title and other collection-level
  state now stay live when changed from another tab, another user, or an
  MCP agent, instead of only refreshing on the next page load.

[0.2.0]: https://github.com/brylie/compendium/releases/tag/v0.2.0

## [0.1.0] - 2026-08-28

Compendium's first public pre-release establishes the core human–agent
collaboration loop: people and MCP agents work on the same live knowledge
workspace with scoped access, visible coordination, and attributed changes.

### Added

- A rich-text document editor with nested pages, slash commands, a persistent
  toolbar, and local per-actor undo and redo.
- Collections with editable Table, Board, and Calendar views, including views
  embedded directly inside documents.
- Real-time CRDT synchronization across the browser UI and MCP clients.
- MCP tools for reading, searching, creating, moving, and editing documents,
  collections, and records.
- Per-record agent holds, human presence, conflict-safe writes, scoped access
  tokens, and a queryable audit trail.
- Stable internal page links, `[[wiki links]]`, explicit broken-link handling,
  and live backlinks.
- SQLite-backed workspace snapshots, access tokens, and audit history.
- Protocol-level and browser-level end-to-end coverage for the collaboration
  boundary.

### Project status

This is a single-tenant, local-trust pre-release intended for local use with
desktop MCP clients. Multi-tenant authentication and production hardening
remain on the roadmap.

[0.1.0]: https://github.com/brylie/compendium/releases/tag/v0.1.0
