# Data model

**Depends on:** [`prd.md`](../prd.md) (all decisions there are inherited, not re-litigated here)

---

## 1. Record/Document/Collection types

```typescript
type ActorId =
	| { kind: 'human'; userId: string }
	| { kind: 'agent'; agentId: string; name: string }
	| { kind: 'human-via-client'; userId: string; client: string }; // "Brylie · via Claude Desktop"

type PropertyValue =
	| { type: 'text'; value: string }
	| { type: 'number'; value: number }
	| { type: 'date'; value: string } // ISO 8601
	| { type: 'select'; value: string } // option id, defined in the Collection's schema
	| { type: 'checkbox'; value: boolean }
	| { type: 'relation'; value: string[] }; // record IDs

interface PropertyDefinition {
	key: string;
	label: string;
	type: PropertyValue['type'];
	options?: { id: string; label: string; color?: string }[]; // for 'select'
	defaultOptionId?: string; // for 'select' — pre-fills onto every newly created record (issue #100), unless the caller already supplies its own value for this field; see collection-views.md §6
	targetCollectionId?: string; // for 'relation' — which Collection its record-id values point into (issue #15)
}

// A block IS a record — this isn't a separate type, just a record whose
// parent is a Document rather than a Collection. Kept as one shape so the
// MCP tool surface never needs to special-case "block vs. row."
// Named WorkspaceRecord (not Record) in the implementation, to avoid
// shadowing TypeScript's built-in Record<K, V> — the `properties` field
// below still uses the built-in generic.
interface WorkspaceRecord {
	id: string; // stable, globally unique
	parentId: string; // Document ID, Collection ID, or (issue #148) another record's id — see §3.1
	order: string; // fractional index, orders records within parentId
	blockType?: BlockType; // set when parent is a Document
	content?: RichText; // set when parent is a Document — the block's text; absent for a container block (columns/column, §3.1), which holds no text of its own
	properties?: Record<string, PropertyValue>; // set when parent is a Collection
	checked?: boolean; // for to_do blocks
	collapsed?: boolean; // for toggle blocks
	// for synced_block / page_link / collection_view blocks; also for
	// child_pages (issue #43) — the target Document whose sub-pages are
	// listed, absent meaning "the current Document" (a different absent-value
	// meaning than page_link/collection_view's "unconfigured")
	referencedRecordId?: string;
	viewConfig?: EmbeddedViewConfig; // for collection_view blocks only — see §2
	// Opts a block out of the page's content-width column so it spans the
	// full document canvas instead (issue #150) — Notion's per-block
	// full-width toggle. Not enforced to a specific blockType at this layer
	// (the same way calloutStyle/childPagesDepth aren't either), but only
	// collection_view blocks currently expose the UI toggle for it — see
	// collection-views.md and design-system.md's content-column section.
	// Absent/false means the normal narrow column.
	fullWidth?: boolean;
	calloutStyle?: CalloutStyle; // for callout blocks only — absent renders the pre-#42 neutral default, see collection-views.md's sibling pattern and design-system.md §6
	childPagesDepth?: ChildPagesDepth; // for child_pages blocks only — absent means depth 1 (immediate children only), see §3
	url?: string; // for bookmark blocks only (issue #155, §3) — absent means "unconfigured", the same absence convention page_link/collection_view's referencedRecordId already use
	bookmarkMetadata?: BookmarkMetadata; // for bookmark blocks only — the server-fetched preview state, see §3
	// Present (possibly empty) only on a container block (columns/column,
	// issue #148, see §3.1) — its own child records' ids, in order, one
	// level below this record rather than in its owning Document's own
	// recordIds. Its mere presence, not a hardcoded blockType check, is what
	// makes a record a valid `parentId` target — see parentKindOf.
	childRecordIds?: string[];
	createdBy: ActorId;
	createdAt: number;
	lastEditedBy: ActorId;
	lastEditedAt: number;
}

type BlockType =
	| 'paragraph'
	| 'heading_1'
	| 'heading_2'
	| 'heading_3'
	| 'heading_4'
	| 'bulleted_list_item'
	| 'numbered_list_item'
	| 'to_do'
	| 'quote'
	| 'divider'
	| 'callout'
	| 'toggle'
	| 'table'
	| 'code'
	| 'table_of_contents'
	| 'synced_block'
	| 'page_link'
	| 'embed'
	| 'bookmark' // rich preview card for a pasted URL, with a plain-link fallback — see §3, issue #155
	| 'collection_view' // embeds a Table/Board/Calendar view of a Collection — see §2
	| 'child_pages' // live listing of a Document's sub-pages (Confluence-style page tree) — see §3, issue #43
	| 'columns' // multi-column layout container — see §3.1, issue #148
	| 'column'; // one column of a columns block — see §3.1, issue #148

// The block types a `column` may directly hold (issue #148) — see §3.1. A
// deliberately curated subset, not the full BlockType union: no reference/
// structural/container types (no nested columns, no callout/toggle/table/
// page_link/collection_view/child_pages/embed/synced_block/
// table_of_contents inside a column for v1).
type ColumnChildBlockType = Extract<
	BlockType,
	| 'paragraph'
	| 'heading_1'
	| 'heading_2'
	| 'heading_3'
	| 'heading_4'
	| 'bulleted_list_item'
	| 'numbered_list_item'
	| 'to_do'
	| 'quote'
	| 'divider'
>;

// "View" always means a Collection/database view here (Notion's sense),
// never an MVC-style page/route. There is no standalone view route — a View
// is configuration that exists only as a collection_view block's viewConfig.
type ViewType = 'table' | 'board' | 'calendar';

// A bookmark block's server-fetched preview state (issue #155) — 'pending'
// right after a url is set (before the fetch resolves), 'ready' once the
// fetch itself completed without error (title/description/favicon/thumbnail
// are each independently optional even then — a page with no OpenGraph tags
// and no <title> is still a successful, 'ready' fetch, just with less to
// show), 'error' when the fetch itself failed (network error, non-2xx
// status, non-HTML response, or the SSRF/timeout/size guards in
// $lib/server/link-preview.ts). The block's own `url` is always present once
// configured regardless of status, so a plain accessible link is never lost
// in either the 'pending' or 'error' state.
type BookmarkFetchStatus = 'pending' | 'ready' | 'error';

// Whole-value, like CalloutStyle: one server-side fetch
// (refreshBookmarkMetadata, services/records.ts) replaces this atomically as
// a unit, never edited member-by-member the way viewConfig's members are.
interface BookmarkMetadata {
	status: BookmarkFetchStatus;
	title?: string;
	description?: string;
	faviconUrl?: string;
	thumbnailUrl?: string;
	fetchedAt?: number; // epoch ms of the last fetch attempt, success or failure
}

// How many levels of sub-pages a child_pages block renders below its target
// Document (issue #43) — 1 (the default, absent value) lists immediate
// children only, a higher integer lists that many nesting levels, and
// 'unlimited' walks the whole subtree. Mirrors Confluence's "Children
// Display" macro's own depth option.
type ChildPagesDepth = number | 'unlimited';

// The four Starlight/Confluence-aligned semantic callout styles (issue #42) —
// see design-system.md §6 for their actual colors/icons.
type CalloutPreset = 'note' | 'tip' | 'caution' | 'danger';

// The icons a callout may use — the four preset icons plus one neutral
// extra, not the full icon roster (design-system.md §4).
type CalloutIcon = 'callout' | 'lightbulb' | 'warning' | 'danger' | 'star';

type CalloutStyle =
	| { kind: 'preset'; preset: CalloutPreset }
	// `color` is the single base color the user picked; light/dark
	// background+text pairs are derived from it at render time
	// (deriveCustomCalloutColors), not stored — see design-system.md §6.
	| { kind: 'custom'; icon: CalloutIcon; color: string };

// Table-only per-column footer aggregation — see collection-views.md §9.
type FieldSummaryType =
	| 'none'
	| 'count_all'
	| 'count_values'
	| 'count_empty'
	| 'sum'
	| 'average'
	| 'min'
	| 'max'
	| 'earliest'
	| 'latest'
	| 'checked'
	| 'unchecked';

interface EmbeddedViewConfig {
	viewType: ViewType;
	filters?: {
		propertyKey: string;
		op: 'is' | 'is_not' | 'is_empty' | 'is_not_empty';
		value?: string;
	}[];
	sort?: { mode: 'manual' | 'property'; propertyKey?: string; direction?: 'asc' | 'desc' };
	visibleProperties?: string[]; // property keys; undefined = all visible
	groupBy?: string; // property key driving the layout: select for Board, date for Calendar
	swimlaneBy?: string; // Board-only second grouping dimension, distinct from groupBy — issue #67/#165
	summaries?: Record<string, FieldSummaryType>; // property key -> footer aggregation (Table only)
}

interface RichText {
	// Conceptually a run array (see PRD's Core Architectural Principle). Concretely,
	// realized as a Y.Text with formatting attributes — see §2. This TypeScript
	// shape is what the MCP boundary and the UI layer both see; the Y.Text
	// encoding is an internal storage detail behind it.
	runs: { text: string; marks: TextMarks }[];
}

interface TextMarks {
	bold?: boolean;
	italic?: boolean;
	strikethrough?: boolean;
	code?: boolean;
	link?: string;
	mention?: string; // ActorId's userId or agentId
}

interface Document {
	id: string;
	title: string;
	parentDocumentId?: string; // absent (not null) for a root/top-level Document
	order: string; // fractional index, orders sibling Documents under the same parent
	recordIds: string[]; // ordered — the Document's blocks, in order
}

interface Collection {
	id: string;
	title: string;
	schema: PropertyDefinition[];
	recordIds: string[]; // membership; row order within a view is a view concern, not stored here
	primaryFieldKey?: string; // schema key of the record's title/identity field — see collection-views.md §7
}
```

## 2. Collections and views

A Collection is the source of truth for structured data: its schema and its member records. A Collection record is a row with typed properties, **not** a hidden Document or a page-shaped wrapper around one. Long-form, block-based knowledge remains a first-class Document; when a workflow needs to connect it to a row, it uses a relation rather than making the row own a second content model.

**Collection titles are unique per-Space** (issue #78), enforced by `services/collections.ts`'s `createCollection`/`updateCollectionTitle` (case-insensitive, trimmed comparison against the catalog's other Collections in the same `spaceId`; throws `DuplicateCollectionTitleError`, surfaced as a 400 at its service-backed entry points — the sidebar/workspace-home create flows and the `/api/collections` route). This is deliberately narrower than Document titles, which are never deduplicated: a Collection is flat (no parent hierarchy — see `collection-views.md`), so two same-titled Collections in one Space would be genuinely indistinguishable in any list that shows them (the sidebar, workspace home, the `/settings/tokens` allowlist), with no page-tree position to disambiguate by the way a Document has. Scoped per-Space, not workspace-wide, so the same title in two different Spaces (e.g. two teams each with their own "Sprint Tasks") remains a normal, intended pattern. The check only guards new creates/renames going forward — pre-existing duplicate titles from before this constraint existed are left alone, and a Collection renamed live via `/table/[id]`'s title field (a direct `Y.Doc` write for real-time typing, bypassing the service layer the same way a Document's title does) isn't covered by it either; see the tracked follow-up issue for closing that gap.

A view is a non-owning projection of one Collection — Table, Board, and Calendar are implemented (see [`collection-views.md`](./collection-views.md)); Gallery, Timeline, Form, and Chart are not yet built. **"View" always means this — a database/Collection view, Notion's sense of the word — never an MVC-style page or route.** There is deliberately no standalone view route: a View exists only as `viewConfig` on a `collection_view` block, which is a Document block like any other (a paragraph, a heading, a `page_link`) rather than a page of its own. Placing one inside a Document — a "team page," a project page, any prose page — is how a Board or Calendar is surfaced at all; `/table/[id]` is the one exception, a pre-existing full-page Table route for a Collection that predates and is unrelated to this embedding mechanism.

A view may have configuration — filters, sorts, grouping, visible properties, and a layout-specific driving property — but it never copies records, changes their identity, or introduces view-specific row fields. That configuration lives on the embedding block's own `viewConfig` field (`EmbeddedViewConfig` above) — a `WorkspaceRecord` field like `referencedRecordId`, not a second write path. `referencedRecordId` names the target Collection (the same field `page_link`/`synced_block` already use for "what this block references"); `viewConfig` says how to render it. Both are set together once insertion is configured, and can be changed later without changing the block's identity — a newly inserted, not-yet-configured `collection_view` block temporarily has neither field set, while the inline picker (`collection-views.md` §2) is showing.

A `collection_view` block may also be displayed full-width (`WorkspaceRecord.fullWidth`, issue #150), breaking out of the Document's normal content-width column — Notion's per-block full-width setting. This is a display/layout choice about the embedding block, not view configuration: it's a plain scalar on the record (like `referencedRecordId`), set instantly via `setRecordFullWidth`/`CollectionViewBlock.svelte`'s own toggle, not part of `EmbeddedViewConfig` or its draft/Save flow. See `collection-views.md` §2 and `design-system.md`'s content-column section for the rendering mechanics and narrow-viewport behavior.

GitLab projects are the interaction reference for Board and data-grid configuration: users can choose visible fields, a grouping property (Board columns or Calendar placement — Table doesn't use `groupBy`), manual or property-based sort, filtering, and (Table only) per-column footer summaries (next paragraph) — all implemented today in `EmbeddedViewConfig`, including an optional second Board grouping dimension (`swimlaneBy`, issue #67/#165 — see `collection-views.md` §3/§4). These choices are declarative view configuration, not Collection schema changes. Moving a card between Board columns updates the selected existing property; rearranging a manually sorted view updates only its view ordering. A Table view (whether the `/table/[id]` full page or a `collection_view` block with `viewType: 'table'`) is an application data grid with this configuration, distinct from the `table` Document block, which is inline narrative content.

Column summaries (issue #32, see [`collection-views.md`](./collection-views.md) §9) are computed view output, not a stored aggregate record — `EmbeddedViewConfig.summaries` persists only the type-appropriate aggregation _choice_ per column (`count_all`/`sum`/`average`/etc., picked from the type-appropriate options `summaryOptionsForType` offers), the same declarative-config role as `filters`/`sort`/`groupBy`; the aggregation itself is recomputed client-side over a view's currently-projected records on every read via `computeFieldSummary`, never written back. Relation rollups are a separate, still-unbuilt computed-property concern. Neither creates a second write path.

A `collection_view` block is exactly the "inline or linked Collection view in a Document" this section used to describe as future work — a reference plus view configuration, not an embedded copy of the Collection. Two `collection_view` blocks pointing at the same Collection with different `viewConfig` are independent views of the same live records; editing either edits the source Collection directly. Dashboards, when built, would compose multiple such non-owning views rather than creating another store of aggregate data.

## 3. Document hierarchy and block-type rules

Document hierarchy is represented by `Document.parentDocumentId`, not by a block. A child Document remains a first-class Document with its own `recordIds`; `order` orders it among the same parent's children. A `page_link` block is therefore only an explicit navigation reference to another Document, never the source of containment — see [`internal-links.md`](./internal-links.md) for how it (and inline `[[wiki links]]`) resolve their `referencedRecordId`/target ID to a title, and what happens once that target is deleted.

Blocks are deliberately a small, documentation-oriented set rather than one type per external service. All CRDT, permission, hold, and MCP behavior operates on `WorkspaceRecord` generically. Adding a text-based block type therefore requires its discriminator, UI renderer and slash-menu entry, and Markdown transcoding behavior—not a new storage or coordination primitive.

- `table_of_contents` is a computed block: its rendered entries are derived from the containing Document's headings rather than a copied `Y.Text` outline.
- `synced_block` references the source record through `referencedRecordId`; editing or holding the rendered block operates on that source record rather than an independent copy. Content convergence itself needs no bespoke propagation logic — a `synced_block` carries its own (unused) `content` field but the UI resolves it through the source's `Y.Text` instead (`syncedBlockTargetId` in `+page.svelte`), so both locations are the same shared CRDT text.
  - **Provenance/detach UX (issue #153):** a source record with one or more instances shows a small always-visible "Used in N places" affordance (`SyncedBlockUsage.svelte`) — the same control on the source lists every instance, and on an instance lists the source plus every sibling instance, each a working link (`resolve('/space/[spaceId]/doc/[id]')` + `#block-<id>`, same pattern as `page_link`'s own href). It's deliberately ambient rather than a per-keystroke confirm dialog — visible before any edit starts, not gating each one — which is what satisfies "warn before an edit that will propagate" here. `detachSyncedBlock` (`record-ops.ts`) breaks one instance out of the group: it bakes the source's current `blockType`/content/checked/collapsed/calloutStyle into the instance's own (previously-unused) fields and clears `referencedRecordId`, in place — the instance keeps its own id, so anything already pointing at it (a copied block link, an undo entry) keeps working. A broken reference (deleted or never-set source) still detaches, to an empty paragraph, since detach is meant as an escape hatch from a stale reference too.
  - **Same-shard scope, today:** this reverse index (`listSyncedBlockInstances`, `links.ts`) is built the same way `listIncomingLinks`' backlink index is — scanning one `Y.Doc` — and since each Document now resolves to its own shard (#120), that's just the current Document. A `synced_block` instance in a _different_ Document can't actually mirror this source's content at all yet regardless (its own `getRecordYText` lookup finds nothing in that Document's own `Y.Doc`), so it couldn't appear in "used in N places" either way — true cross-Document synced blocks need shard-aware resolution first, tracked as issue #242, not attempted here.
- `collection_view` references a Collection through `referencedRecordId` and carries its rendering configuration in `viewConfig` (§2) — the mechanism behind Table/Board/Calendar embedding, see [`collection-views.md`](./collection-views.md).
- `embed` is the generic external-content mechanism. Dedicated per-service block types are intentionally out of scope.
- `bookmark` (issue #155) is a leaf block for a pasted/typed external URL — distinct from `embed` (the PRD's own framing, `docs/prd.md`): pasting a URL into an empty text block, or configuring one via the slash menu, offers a rich preview card (title/description/favicon/thumbnail, fetched server-side — `$lib/server/link-preview.ts`) that always degrades to a plain accessible link (its own `url` field) when the fetch is still pending, failed, or the block is unconfigured. `url` follows the same "absent means unconfigured" convention as `page_link`/`collection_view`'s `referencedRecordId`; `bookmarkMetadata` is a single whole-value field (like `calloutStyle`), replaced atomically by one fetch operation rather than edited member-by-member the way `viewConfig` is, since there is exactly one actor (the fetch) ever writing it. Like `synced_block`, a `bookmark` block is allocated a `content` `Y.Text` at creation (same as every non-container block) but never renders or reads it — its real content lives entirely in `url`/`bookmarkMetadata`; `write_record`'s `markdown` field is rejected outright against a `bookmark` block for exactly this reason (`services/records.ts`), the same "nowhere to go" guard `columns`/`column` blocks already have. There is no MCP write path for reconfiguring an existing bookmark's `url` (only `create_record`'s initial value) — a `url` change needs a fresh async fetch that `write_record`'s synchronous contract doesn't accommodate; see `mcp-tools.md`'s `refresh_bookmark_metadata` tool for re-fetching an already-set `url`'s preview. `bookmarkMetadata.faviconUrl`/`thumbnailUrl` are never rendered as a raw `<img src>` in the UI: `link-preview.ts`'s scrape-time `resolvePublicAssetUrl` check only ever validates a hostname _once_, and a raw external `<img src>` would leave the viewer's own browser to do a fresh DNS resolution and follow any redirect the image host sends — neither controlled by that one-time check. `BookmarkBlock.svelte` instead points at a same-origin proxy (`src/routes/api/records/[id]/bookmark-asset/+server.ts`, backed by `services/records.ts#getBookmarkAssetUrl` and `link-preview.ts#fetchImageAsset`) that re-resolves, re-pins, and re-validates the address on every request — the same guard `requestHop` already applies to the primary HTML fetch, applied again per render instead of once per scrape.
- `child_pages` (issue #43) is a live, Confluence-style page-tree listing of a target Document's sub-pages, computed from `Document.parentDocumentId`/`order` rather than a copied outline — the same "computed block" category as `table_of_contents`, one level up the hierarchy. `referencedRecordId` names the target Document; absent, it defaults to the block's own containing Document (unlike `page_link`/`collection_view`, where absent means "unconfigured" — see `mcp-tools.md` for how `get_document`/`create_record` handle this distinction). `childPagesDepth` (absent = 1) bounds how many nesting levels are rendered. `src/lib/data/records.ts`'s `resolveChildPages` resolves the listing from a flat `DocumentMeta[]` (client: the catalog-backed `data.documents` load already used for the sidebar/`page_link` picker; server: `listDocuments(caller)`, already permission-scoped) — a child the caller can't see is silently omitted from the listing, not surfaced as broken, since only the block's own _target_ is a single resolved reference the way `page_link`'s is. **Liveness scope, deliberately narrower than `table_of_contents`'s:** on the MCP boundary this is always fully live and correct — `get_document` re-reads the catalog on every call, no caching. In the browser UI it is **not** cross-client live — a Document's title/hierarchy is catalog-backed, not part of any single Document's own Yjs shard (#120), so a `child_pages` block only re-renders when this session's own SvelteKit data is invalidated (creating/deleting a sub-page through the sidebar or the block's own controls), the same explicit, accepted gap `Sidebar.svelte`'s document tree already has pending Phase C's SSE feed (#121) — not something this issue attempts to close.
- Binary media (`image`, `file`, `pdf`, `video`, and `audio`) is deferred until an asset-storage design defines stable references, backups, and sync behavior; it is not merely another text-block discriminator.

### 3.1 Container blocks: real nesting (`columns`/`column`, issue #148)

Every block type above is a leaf under its Document — `parentId` names the Document directly, and the Document's own `recordIds` is the complete, flat ordering of every block in it. `columns`/`column` are the first exception: a `columns` block's children are `column` blocks, and a `column` block's own children are ordinary blocks (the curated `ColumnChildBlockType` subset above) — two more levels of nesting below the Document, each with its **own** `recordIds` array (`WorkspaceRecord.childRecordIds`), not one more entry in the Document's. This is a real, generic storage/coordination primitive, not just "a new discriminator" the way a text-based block type is (§3's sentence above describes every _other_ block type, not this one) — see `record-ops.ts`'s `parentKindOf`, which now resolves three parent kinds instead of two: `'document'`, `'collection'`, or `'record'` (a container block, identified by the presence of its own `childRecordIds` array, not a hardcoded blockType check).

Practically: `createRecord`'s `parentId` may be a `columns`/`column` block's own id, and `listRecordsForParent`/`reorderRecord` operate on that container's own array exactly as they would a Document's. `createColumnsBlock` is the only way a `columns` block comes into existence — one transaction creates it plus `columnCount` (2–6, default 2) `column` children, each pre-seeded with one empty paragraph so no column is ever left with nothing to click into; a bare `column` created directly (an MCP agent adding a column via `create_record`) gets the same auto-seeded paragraph. `moveRecordToParent` is the new reparenting primitive `reorderRecord` doesn't cover — it moves a block from one container into a different one (dragging, or a keyboard ArrowLeft/ArrowRight, between two columns of the same `columns` block), rejecting a move into the record's own descendant. `deleteRecord` recurses into a container's `childRecordIds` before deleting it, so removing a `columns` block or a single `column` also removes everything nested inside it.

**Nesting is capped at these two levels for v1** — a `columns` block only valid directly inside a Document (no `columns` nested inside a `column`), a `column` only valid directly inside a `columns` block, and anything else only valid directly inside a Document or inside a `column` (never directly inside a bare `columns` block — content always goes in one of its columns). `services/records.ts`'s `validateBlockTypeForParent` enforces all of this at the one MCP/UI-adjacent write boundary that has policy at all; `record-ops.ts`'s primitives themselves stay structurally generic (any record with a `childRecordIds` array is a valid parent), the same "primitives are policy-free, services own policy" split `service-layer.md` already establishes for everything else.

**Permission scoping doesn't change:** an access token's allowlist is still keyed by Document/Collection id only (`mcp-tools.md`) — a container record is never itself a grantable id. `resolveOwningParentId` (`services/permissions.ts`) walks a record's `parentId` chain up to its owning Document/Collection before every permission check (`requireAccessibleParent`/`requireAccessibleRecord`, and the token-caller branch of `holdRecords`), so a token granted a Document can create/write/delete/hold a block nested inside one of its `columns` blocks without needing a separate grant for the column itself. This walk is a no-op (one extra lookup that immediately returns) for every pre-#148 record, which was already top-level.

**Migration and MCP read-side implications:** a shard migration (`migration-copy.ts`'s `copyRecordVerbatim`) recurses into a container's `childRecordIds` the same way `copyDocumentVerbatim` recurses into a Document's own `recordIds`, or a `columns` block's nested content would be silently dropped when its Document moves to a real per-record shard. `get_document`'s protocol-neutral `DocumentRecordData` (and the MCP-facing `DocumentRecordView` it projects to) carry a generic `children` field, populated the same recursive way, for any record with `childRecordIds` — so `columns` (and any future container type) is visible to an MCP agent without a dedicated tool; see `mcp-tools.md` and `markdown-transcoding.md` for the read-side markdown shape.

## 4. Yjs mapping

One `Y.Doc` per Document and one `Y.Doc` per Collection (#113/#132), each independently subscribed, loaded, and persisted — not a single workspace-wide `Y.Doc`, which was accurate Phase-0 behavior superseded by this shard split. A server-owned SQLite catalog (`src/lib/server/catalog.ts`, [`workspace-sharding.md`](./workspace-sharding.md) §1–§3) is the durable source of truth for a Document/Collection's title, hierarchy, and `spaceId`; a Document's own `Y.Doc` stores only that Document's own meta entry and blocks, not its siblings or descendants. A pre-#113 workspace's content migrates into this shape via `migrateWorkspace()` (`src/lib/server/migration.ts`, §7) rather than being rewritten in place.

**Space** (#6, #133) is a catalog-only concept — an organizational grouping of Documents/Collections within one workspace (`SpaceMeta` in `src/lib/data/types.ts`, the `spaces` table in `db/schema.ts`). It has no `Y.Doc` or CRDT content of its own: a Space's membership is just the `spaceId` column already present on each Document/Collection's catalog row, and shard routing (which `Y.Doc` a given Document/Collection lives in) stays per-record, entirely orthogonal to which Space that record belongs to. Content isolation between two Spaces is therefore a catalog-read concern (does `listDocuments`/`listCollections`/`searchWorkspace` filter by `spaceId`), not a Yjs-sharding one — the per-record shard split already isolates content more finely than Space ever needs to.

<!-- prettier-ignore -->
| Concept | Yjs type | Notes |
| --- | --- | --- |
| Documents index | `Y.Map<string, DocumentMeta>` | keyed by Document ID; `DocumentMeta` is `{title, parentDocumentId?, order, recordIds: Y.Array<string>}` — a Document nested under a parent stores that parent's ID directly on its own meta entry, alongside its sibling-ordering `order` |
| Collections index | `Y.Map<string, CollectionMeta>` | keyed by Collection ID; includes `schema` as a plain JSON value (schema edits are rare, don't need fine-grained CRDT merge) |
| Records | `Y.Map<string, Y.Map>` | keyed by record ID; each record's own `Y.Map` holds every `WorkspaceRecord` scalar field directly (`id`, `parentId`, `order`, `blockType`, `checked`, `collapsed`, `referencedRecordId`, `calloutStyle`, `childPagesDepth`, `fullWidth`, `createdBy`, `createdAt`, `lastEditedBy`, `lastEditedAt`), an internal `isCollectionRow` flag distinguishing collection rows from Document blocks, one entry per property (so concurrent edits to different properties merge independently, per Yjs's own key-level CRDT semantics — not a single nested JSON blob), one entry per `viewConfig` member for `collection_view` blocks (same per-member merge rationale — see below); a non-container block-record additionally gets `content`, while a container block (`columns`/`column`, §3.1) gets no `content` at all — a container never holds its own free-form text, only children — and instead gets its own `recordIds: Y.Array<string>`, the same shape and role Documents/Collections' own `recordIds` already play, just one level further down |
| Block rich text | `Y.Text` | one per block-record, stored as the record's `content` field. **Not** a custom run array — Yjs's own `Y.Text.format()` already stores marks as attribute ranges over the text and merges concurrent overlapping formatting correctly (see PRD's rich-text acceptance criterion). The `RichText.runs` shape in §1 is derived from `Y.Text` on read, not stored separately. |

**Why not a `Y.Text` per Document instead of one per block:** merging at the whole-document level would make block-level hold/release (see [`collaboration.md`](./collaboration.md)) meaningless — the CRDT and the coordination layer need to operate at the same granularity. One `Y.Text` per block-record keeps them aligned.

**`viewConfig`'s merge granularity:** unlike `checked`/`collapsed`/`referencedRecordId` (still one whole-value `Y.Map.set` each — a single scalar, so there's nothing to decompose), `EmbeddedViewConfig`'s members (`viewType`, `filters`, `sort`, `visibleProperties`, `groupBy`, `swimlaneBy`, `summaries`) are each written as their own `viewConfig:<field>` `Y.Map` entry, the same `prop:<key>`-style flattening a Collection row's `properties` already use (§1) — so two actors editing _different_ `viewConfig` members concurrently (one changes `filters`, another changes `sort`) merge independently instead of one clobbering the other (issue #71). `setRecordViewConfig` (`src/lib/data/records.ts`) still replaces every member at once, for an outright reconfigure (a brand new embed, or switching its view type/target) where resetting everything together is correct; `patchRecordViewConfig` writes only the members named in its patch — restricted to `Partial<ViewConfig>`, so `viewType` itself can never be patched — and is what an in-place edit (e.g. `CollectionViewBlock.svelte`'s Save, via `views.ts`'s `diffViewConfig`) should use instead.

**Legacy pre-#183 records:** a `collection_view` block persisted before this split stores its whole `EmbeddedViewConfig` under one plain `viewConfig` key. Reads (`readViewConfig`) fall back to that key, read-only, when no `viewConfig:viewType` entry exists, so an already-persisted embed doesn't appear unconfigured. Any subsequent partial write to the record (`patchRecordViewConfig`, or the property/option-removal repair functions) migrates it into the prefixed entries and deletes the legacy key first, in the same transaction as that write — a one-time, lazy per-record upgrade rather than a standalone migration pass, since Phase 0 is single-tenant and the number of already-persisted `collection_view` blocks is small. A full `setRecordViewConfig` replace also clears the legacy key, since it already rewrites every prefixed field.
