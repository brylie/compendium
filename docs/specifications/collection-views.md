# Collection views: Table, Board, Calendar

**Depends on:** [`data-model.md`](./data-model.md) §2 (Collections and views), [`service-layer.md`](./service-layer.md)

---

## 1. Scope

This covers the shared view-projection model and the Board/Calendar renderers built on it (issue #9), plus the "smallest shared view configuration" (`ViewConfig`) they needed (a deliberately minimal slice of #32's fuller ambition — see §5 for what's still open there). It does **not** cover saved-view persistence, Document-embedded/linked views (#37), or aggregations/charts/dashboards (#10) — those remain separate, unimplemented issues.

## 2. The shared projection: `src/lib/data/views.ts`

A Collection stays the sole structured-data source of truth (`data-model.md` §2): this module only ever reads `WorkspaceRecord[]`/`PropertyDefinition[]` already loaded from Yjs and returns derived arrays. Nothing here mutates a record, copies one, or adds a view-specific field.

- `getCollectionView(doc, collectionId)` — the one Collection query/projection path. Table, Board, and Calendar all call this (directly or via the same `getCollection`/`listRecordsForParent` primitives), so a record edit shows up identically in whichever view is open — there's no separate per-view data path to fall out of sync.
- `ViewConfig` — `{ filters?, sort?, visibleProperties?, groupBy? }`. `filters` is an array of `{ propertyKey, op: 'is' | 'is_not' | 'is_empty' | 'is_not_empty', value? }`, ANDed together. `sort` is `{ mode: 'manual' | 'property', propertyKey?, direction? }` — `'manual'` leaves record order as-is (Board additionally layers a session-local per-column drag order on top, see §3). `visibleProperties` is a property-key allowlist; omitted means "all visible" (Table's own current behavior, unchanged).
- `applyFilters` / `applySort` / `projectRecords` — pure functions composing the above over a records array.
- `groupBySelectProperty(records, property)` — Board's column grouping. Returns one `BoardColumn` per schema-defined option, **in schema order, even when empty** (data-model.md's "preserve empty groups… do not create placeholder records" — an empty column is a rendering fact about the schema, not a record), plus a trailing catch-all column for records with no value (or an option ID no longer in the schema).
- `dateKeyForRecord(record, property)` — the `YYYY-MM-DD` portion of a `date` property's value, or `undefined` if unset. Calendar buckets records by this key; records where it's `undefined` render in an "Unscheduled" list rather than being silently dropped.

This is the entire "smallest shared configuration" issue #9 asked for — it is not `query_collection`'s eventual filter/sort implementation (see §5).

## 3. Board (`/board/[id]`)

- **Grouping property**: any `select`-type property in the Collection's schema; a dropdown lets the user switch which one drives columns if there's more than one. If the schema has none, the view shows a prompt to add one (`updateCollectionSchema`, the same call `/table/[id]`'s schema editor already uses) rather than silently rendering nothing.
- **Columns**: one per option (in schema order) plus a "No `<property>`" catch-all, per `groupBySelectProperty` above — always rendered, even empty.
- **Cards**: show the record's first `text`-type property as a title, plus whatever other schema properties are in `ViewConfig.visibleProperties` (default: all, minus the grouping and title properties, which are already shown structurally). Each visible property renders through the same `PropertyValueCell.svelte` Table uses for its grid cells — one property-type-to-editor mapping shared across every view, not reimplemented per view.
- **Moving a card between columns** — via native HTML5 drag-and-drop, or the card's own field editor if the grouping property is also a visible field — updates that record's existing grouping property (`updateRecordProperties`), exactly as `data-model.md` §2 specifies; it is never a reorder of Collection membership or a record copy.
- **Manual sort** (the default `ViewConfig.sort` mode): dragging a card to a specific position within a column reorders it there. This ordering is **session-local component state** (`manualOrder: Record<columnKey, recordId[]>`), not written to the record or the Collection — see §4 for why.
- **Property sort**: switching `ViewToolbar`'s sort mode to "Sort by property" orders every column's cards by a chosen property/direction instead, computed via `applySort`.

## 4. Calendar (`/calendar/[id]`)

- **Date property**: any `date`-type property; same add-one-if-missing prompt as Board's grouping property when the schema has none.
- **Month grid**: always a fixed 6-row/42-cell grid (leading/trailing days from the adjacent months included, per the common Board/GitLab-reference calendar convention), so the grid's shape doesn't jump between 5- and 6-row months.
- **Placement**: a record renders on the day cell matching `dateKeyForRecord`. A record with no value for the chosen date property is never hidden — it renders in an "Unscheduled" section below the grid instead.
- **Editing the date**: each entry (scheduled or unscheduled) renders the date property inline via `PropertyValueCell`, so rescheduling — including giving an unscheduled record its first date — is a direct edit, not a drag-only interaction.
- **Adding an entry**: a day cell's "+" button creates a record with that day pre-filled into the date property (`createRecord`), the same pattern Table's "Add row" and Board's "Add card" use.

## 5. What this deliberately leaves open

- **Saved-view persistence.** `ViewConfig` (filters/sort/visible-properties/grouping-property choice) lives in each page's own `$state`, reset on reload. `data-model.md` §2 already flagged this as a decision to make "when the view work is prioritized" — this feature makes that choice concretely for its own initial cut (ephemeral, not persisted) rather than deciding it implicitly. A later saved-view feature would need to pick where a `ViewConfig` is stored (per-Collection default? per-user? a new Yjs structure, or a `persistence.md`-style SQLite table?) and how it interacts with the permission model — none of that is decided here.
- **MCP parity.** `query_collection`'s `filter` parameter is still an accepted-but-unused no-op (pre-existing, not introduced by this feature — see `src/lib/mcp/server.ts`), and there is no MCP-facing grouping/sort equivalent to Board/Calendar's. An agent today gets the same unfiltered `rows` regardless of what a human's Board/Calendar view is configured to show. `query_collection` already reads from the Yjs doc directly, the same source `views.ts` projects over — not the SQLite read model `persistence.md` §2 describes for it, which isn't built (verified against `src/lib/server/db/schema.ts`: no such table exists; see [`mcp-tools.md`](./mcp-tools.md)'s `query_collection` row for the corrected description). Closing the filter/sort gap, and deciding whether that read model gets built as specced or the direct-Yjs-read approach gets formalized instead, is tracked separately, not solved here.
- **Board swimlanes.** Issue #9 listed optional swimlanes (a second grouping dimension) as a stretch goal; this cut ships single-dimension column grouping only.
