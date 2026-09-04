// Data model per docs/technical-design.md §2 and docs/phase-1-plan.md M1-M3.
// Note: the spec calls the record primitive "Record" — renamed to
// WorkspaceRecord here to avoid shadowing TypeScript's built-in Record<K, V>.

export type ActorId =
	| { kind: 'human'; userId: string }
	| { kind: 'agent'; agentId: string; name: string }
	| { kind: 'human-via-client'; userId: string; client: string }; // "Brylie · via Claude Desktop"

/** Canonical runtime discriminator list shared by data validation and adapters. */
export const propertyTypes = ['text', 'number', 'date', 'select', 'checkbox', 'relation'] as const;
export type PropertyType = (typeof propertyTypes)[number];

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
	targetCollectionId?: string; // for 'relation' — which Collection its record-id values point into
}

/** Canonical runtime discriminator list for Document blocks. */
export const blockTypes = [
	'paragraph',
	'heading_1',
	'heading_2',
	'heading_3',
	'heading_4',
	'bulleted_list_item',
	'numbered_list_item',
	'to_do',
	'quote',
	'divider',
	'callout',
	'toggle',
	'table',
	'code',
	'table_of_contents',
	'synced_block',
	'page_link',
	'embed',
	'collection_view',
	'child_pages'
] as const;
export type BlockType = (typeof blockTypes)[number];

// "View" here means a Collection/database view (Table/Board/Calendar — a
// rendering + configuration over a Collection's records), never an MVC-style
// page/route view. A collection_view block is the only place a view exists
// as a persisted thing; there is deliberately no standalone "view route."
export type ViewType = 'table' | 'board' | 'calendar';

// The four Starlight/Confluence-aligned semantic callout styles (issue #42) —
// each maps to a fixed, hand-tuned light/dark background+text token pair (see
// layout.css's --color-callout-<preset>-{bg,fg}) and a fixed icon
// (see CALLOUT_PRESETS in $lib/data/callout-style.ts), not a user choice.
export type CalloutPreset = 'note' | 'tip' | 'caution' | 'danger';

// The icons a callout may use — the four preset icons plus a couple of
// generic options for a custom callout, not the full Icon.svelte roster
// (most of which are block-type icons that would look wrong on a callout).
export type CalloutIcon = 'callout' | 'lightbulb' | 'warning' | 'danger' | 'star';

// A collection_view block's viewConfig and a callout's style share the same
// storage rationale: a single value replaced atomically as one unit by its
// own dedicated UI control (the style picker), never independently edited
// field-by-field the way viewConfig's members are — so this is stored
// whole-value (see setRecordCalloutStyle in records.ts), no per-member
// decomposition needed the way issue #71 required for viewConfig.
export type CalloutStyle =
	| { kind: 'preset'; preset: CalloutPreset }
	// `color` is the single base color the user picked (a hex string); the
	// actual light/dark background+text pairs are derived from it at render
	// time (deriveCustomCalloutColors in $lib/data/callout-style.ts), not
	// stored — computed text contrast must never go stale relative to a
	// separately-stored, independently-editable color.
	| { kind: 'custom'; icon: CalloutIcon; color: string };

// How many levels of sub-pages a child_pages block renders below its target
// Document — 1 (the default, absent value) lists immediate children only, a
// higher integer lists that many nesting levels, and 'unlimited' walks the
// whole subtree. Mirrors Confluence's "Children Display" macro's own depth
// option (issue #43).
export type ChildPagesDepth = number | 'unlimited';

// One node of a child_pages block's resolved listing — deliberately lighter
// than DocumentTreeNode (no `order`/`recordIds`/`spaceId`/`level`): this is
// read-only display output, not a Document read model in its own right.
export interface ChildPageNode {
	id: string;
	title: string;
	children: ChildPageNode[];
}

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

// Type-appropriate per-column aggregation shown in Table's footer (issue
// #32) — which summaries are offered for a given property depends on its
// PropertyType, see summaryOptionsForType in $lib/data/views.
export type FieldSummaryType =
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

export interface ViewConfig {
	filters?: ViewFilter[];
	sort?: ViewSort;
	visibleProperties?: string[]; // property keys; undefined = all visible
	groupBy?: string; // property key driving the layout: select for Board, date for Calendar
	summaries?: Record<string, FieldSummaryType>; // property key -> footer aggregation (Table only)
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
	// for synced_block, page_link, and collection_view (the target Collection);
	// also for child_pages (the target Document whose sub-pages are listed) —
	// absent there means "the current Document", a different absent-value
	// meaning than page_link/collection_view's "unconfigured" (issue #43)
	referencedRecordId?: string;
	viewConfig?: EmbeddedViewConfig; // for collection_view blocks only
	calloutStyle?: CalloutStyle; // for callout blocks only — absent renders the pre-#42 neutral default
	childPagesDepth?: ChildPagesDepth; // for child_pages blocks only — absent means depth 1 (immediate children only)
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
	spaceId?: string; // catalog-only — undefined for uncataloged/legacy content
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
	spaceId?: string; // catalog-only — undefined for uncataloged/legacy content
}

export type ParentKind = 'document' | 'collection';
