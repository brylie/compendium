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
}

// A block IS a record — this isn't a separate type, just a record whose
// parent is a Document rather than a Collection. Kept as one shape so the
// MCP tool surface never needs to special-case "block vs. row."
// Named WorkspaceRecord (not Record) in the implementation, to avoid
// shadowing TypeScript's built-in Record<K, V> — the `properties` field
// below still uses the built-in generic.
interface WorkspaceRecord {
	id: string; // stable, globally unique
	parentId: string; // Document ID or Collection ID
	order: string; // fractional index, orders records within parentId
	blockType?: BlockType; // set when parent is a Document
	content?: RichText; // set when parent is a Document — the block's text
	properties?: Record<string, PropertyValue>; // set when parent is a Collection
	checked?: boolean; // for to_do blocks
	collapsed?: boolean; // for toggle blocks
	referencedRecordId?: string; // for synced_block / page_link blocks
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
	| 'embed';

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
}
```

## 2. Collections and views

A Collection is the source of truth for structured data: its schema and its member records. A Collection record is a row with typed properties, **not** a hidden Document or a page-shaped wrapper around one. Long-form, block-based knowledge remains a first-class Document; when a workflow needs to connect it to a row, it uses a relation rather than making the row own a second content model.

A view is a non-owning projection of one Collection. Table, Board, and Calendar (implemented; see [`collection-views.md`](./collection-views.md)) plus Gallery, Timeline, Form, and Chart (not yet built) are renderers or interaction modes over the same records. A view may have configuration such as filters, sorts, grouping, visible properties, and a layout-specific driving property, but it never copies records, changes their identity, or introduces view-specific row fields. Board and Calendar's initial cut keeps this configuration session-local (component `$state`, never written to the Collection or `Y.Doc`) rather than deciding saved-view persistence and ownership up front — `collection-views.md` covers why and what a later saved-view feature would need to add.

GitLab projects are the interaction reference for the initial Board and data-grid configuration: users can choose visible fields, a grouping property (Board columns or Table groups), optional Board swimlanes, manual or property-based sort, filtering, and field summaries. These choices are declarative view configuration, not Collection schema changes. Moving a card between Board columns updates the selected existing property; rearranging a manually sorted view updates only its view ordering. A Table view is an application data grid with this configuration, distinct from the `table` Document block, which is inline narrative content.

Column summaries are computed view output rather than stored properties. Later work may offer count, sum, mean, median, mode, and other type-appropriate aggregations across the records currently included by a view's filter. Relation rollups are a separate computed-property concern. Neither creates a second write path or persisted aggregate record.

An inline or linked Collection view in a Document is likewise a reference plus view configuration, not an embedded copy of the Collection. A full-page Collection is a navigation/rendering choice, not a different data type. Dashboards compose these non-owning views rather than creating another store of aggregate data.

## 3. Document hierarchy and block-type rules

Document hierarchy is represented by `Document.parentDocumentId`, not by a block. A child Document remains a first-class Document with its own `recordIds`; `order` orders it among the same parent's children. A `page_link` block is therefore only an explicit navigation reference to another Document, never the source of containment — see [`internal-links.md`](./internal-links.md) for how it (and inline `[[wiki links]]`) resolve their `referencedRecordId`/target ID to a title, and what happens once that target is deleted.

Blocks are deliberately a small, documentation-oriented set rather than one type per external service. All CRDT, permission, hold, and MCP behavior operates on `WorkspaceRecord` generically. Adding a text-based block type therefore requires its discriminator, UI renderer and slash-menu entry, and Markdown transcoding behavior—not a new storage or coordination primitive.

- `table_of_contents` is a computed block: its rendered entries are derived from the containing Document's headings rather than a copied `Y.Text` outline.
- `synced_block` references the source record through `referencedRecordId`; editing or holding the rendered block operates on that source record rather than an independent copy.
- `embed` is the generic external-content mechanism. Dedicated per-service block types are intentionally out of scope.
- Binary media (`image`, `file`, `pdf`, `video`, and `audio`) is deferred until an asset-storage design defines stable references, backups, and sync behavior; it is not merely another text-block discriminator.

## 4. Yjs mapping

One `Y.Doc` for the whole workspace (single-tenant, single workspace — no need for multiple docs yet).

| Concept           | Yjs type                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documents index   | `Y.Map<string, DocumentMeta>`   | keyed by Document ID; `DocumentMeta` is `{title, parentDocumentId?, order, recordIds: Y.Array<string>}` — a Document nested under a parent stores that parent's ID directly on its own meta entry, alongside its sibling-ordering `order`                                                                                                                                                                                                                                                                                                         |
| Collections index | `Y.Map<string, CollectionMeta>` | keyed by Collection ID; includes `schema` as a plain JSON value (schema edits are rare, don't need fine-grained CRDT merge)                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Records           | `Y.Map<string, Y.Map>`          | keyed by record ID; each record's own `Y.Map` holds every `WorkspaceRecord` scalar field directly (`id`, `parentId`, `order`, `blockType`, `checked`, `collapsed`, `referencedRecordId`, `createdBy`, `createdAt`, `lastEditedBy`, `lastEditedAt`), an internal `isCollectionRow` flag distinguishing collection rows from Document blocks, one entry per property (so concurrent edits to different properties merge independently, per Yjs's own key-level CRDT semantics — not a single nested JSON blob), and — for block-records — `content` |
| Block rich text   | `Y.Text`                        | one per block-record, stored as the record's `content` field. **Not** a custom run array — Yjs's own `Y.Text.format()` already stores marks as attribute ranges over the text and merges concurrent overlapping formatting correctly (see PRD's rich-text acceptance criterion). The `RichText.runs` shape in §1 is derived from `Y.Text` on read, not stored separately.                                                                                                                                                                         |

**Why not a `Y.Text` per Document instead of one per block:** merging at the whole-document level would make block-level hold/release (see [`collaboration.md`](./collaboration.md)) meaningless — the CRDT and the coordination layer need to operate at the same granularity. One `Y.Text` per block-record keeps them aligned.
