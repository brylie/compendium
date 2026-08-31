// Data model per docs/technical-design.md §2 and docs/phase-1-plan.md M1-M3.
// Note: the spec calls the record primitive "Record" — renamed to
// WorkspaceRecord here to avoid shadowing TypeScript's built-in Record<K, V>.

export type ActorId =
	| { kind: 'human'; userId: string }
	| { kind: 'agent'; agentId: string; name: string }
	| { kind: 'human-via-client'; userId: string; client: string }; // "Brylie · via Claude Desktop"

export type PropertyType = 'text' | 'number' | 'date' | 'select' | 'checkbox' | 'relation';

export type PropertyValue =
	| { type: 'text'; value: string }
	| { type: 'number'; value: number }
	| { type: 'date'; value: string } // ISO 8601
	| { type: 'select'; value: string } // option id, defined in the Collection's schema
	| { type: 'checkbox'; value: boolean }
	| { type: 'relation'; value: string[] }; // record IDs

export interface PropertyDefinition {
	key: string;
	label: string;
	type: PropertyType;
	options?: { id: string; label: string; color?: string }[]; // for 'select'
}

export type BlockType =
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
	| 'collection_view'; // embeds a Table/Board/Calendar view of a Collection inline in a Document — see collection-views.md

// "View" here means a Collection/database view (Table/Board/Calendar — a
// rendering + configuration over a Collection's records), never an MVC-style
// page/route view. A collection_view block is the only place a view exists
// as a persisted thing; there is deliberately no standalone "view route."
export type ViewType = 'table' | 'board' | 'calendar';

export type ViewFilterOp = 'is' | 'is_not' | 'is_empty' | 'is_not_empty';

export interface ViewFilter {
	propertyKey: string;
	op: ViewFilterOp;
	value?: string;
}

export type SortDirection = 'asc' | 'desc';

export interface ViewSort {
	mode: 'manual' | 'property';
	propertyKey?: string; // required when mode === 'property'
	direction?: SortDirection; // defaults to 'asc'
}

export interface ViewConfig {
	filters?: ViewFilter[];
	sort?: ViewSort;
	visibleProperties?: string[]; // property keys; undefined = all visible
	groupBy?: string; // property key driving the layout: select for Board, date for Calendar
}

// The full persisted configuration of a collection_view block: which
// renderer plus that renderer's ViewConfig. The target Collection itself is
// referencedRecordId, not part of this — same split synced_block/page_link
// already use (referencedRecordId for "what", a block-local field for "how").
export interface EmbeddedViewConfig extends ViewConfig {
	viewType: ViewType;
}

export interface TextMarks {
	bold?: boolean;
	italic?: boolean;
	strikethrough?: boolean;
	code?: boolean;
	link?: string;
	mention?: string; // ActorId's userId or agentId
}

export interface RichText {
	runs: { text: string; marks: TextMarks }[];
}

// A block IS a record — this isn't a separate type, just a record whose
// parent is a Document rather than a Collection. Kept as one shape so the
// MCP tool surface never needs to special-case "block vs. row."
export interface WorkspaceRecord {
	id: string; // stable, globally unique
	parentId: string; // Document ID or Collection ID
	order: string; // fractional index, orders records within parentId
	blockType?: BlockType; // set when parent is a Document
	content?: RichText; // set when parent is a Document — the block's text
	properties?: Record<string, PropertyValue>; // set when parent is a Collection
	checked?: boolean; // for to_do blocks
	collapsed?: boolean; // for toggle blocks
	referencedRecordId?: string; // for synced_block, page_link, and collection_view (the target Collection)
	viewConfig?: EmbeddedViewConfig; // for collection_view blocks only
	createdBy: ActorId;
	createdAt: number;
	lastEditedBy: ActorId;
	lastEditedAt: number;
}

// A Space is a catalog-only concept (docs/specifications/workspace-sharding.md
// §2) — an organizational grouping of Documents/Collections within one
// workspace, not part of the Yjs domain model itself (no Space Y.Doc, no
// Space CRDT content). Read from the `spaces` table (src/lib/server/db/
// schema.ts), never derived from a Y.Doc the way DocumentMeta/CollectionMeta
// are — kept here anyway since it's the same "read-model shape a caller gets
// back" role those types play.
export interface SpaceMeta {
	id: string;
	workspaceId: string;
	name: string;
}

export interface DocumentMeta {
	id: string;
	title: string;
	parentDocumentId?: string;
	order: string;
	recordIds: string[]; // ordered — the Document's blocks, in order
}

export interface DocumentTreeNode extends DocumentMeta {
	children: DocumentTreeNode[];
	level: number;
}

export interface CollectionMeta {
	id: string;
	title: string;
	schema: PropertyDefinition[];
	recordIds: string[]; // membership; row order within a view is a view concern
	primaryFieldKey?: string; // schema key of the record's title/identity field — see resolvePrimaryField in $lib/data/records
}

export type ParentKind = 'document' | 'collection';
