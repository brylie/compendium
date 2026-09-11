import * as documents from './documents';
import * as records from './records';
import * as holds from './holds';
import * as collections from './collections';
import * as search from './search';
import * as spaces from './spaces';
import * as tokens from './tokens';
import * as audit from './audit';

export const serviceModules = {
	documents,
	records,
	holds,
	collections,
	search,
	spaces,
	tokens,
	audit
} as const;

export type ServiceModuleName = keyof typeof serviceModules;

// Filters module exports down to callable functions only, excluding classes/errors/types
export type MethodOf<M extends ServiceModuleName> = {
	[K in keyof (typeof serviceModules)[M]]: (typeof serviceModules)[M][K] extends (
		...args: never[]
	) => unknown
		? K
		: never;
}[keyof (typeof serviceModules)[M]];

export type ServiceMethod = {
	[M in ServiceModuleName]: `${M}.${MethodOf<M> & string}`;
}[ServiceModuleName];

export interface ServiceSurfaceDefinition {
	mcp: boolean;
	ui: boolean;
	mcpToolName?: string;
	mcpDescription?: string;
}

export const serviceSurfaces: Record<ServiceMethod, ServiceSurfaceDefinition> = {
	'documents.createDocument': {
		mcp: true,
		ui: true,
		mcpToolName: 'create_document',
		mcpDescription: 'Create a new Document, optionally nested under an accessible parent Document.'
	},
	'documents.moveDocument': {
		mcp: true,
		ui: false,
		mcpToolName: 'move_document',
		mcpDescription: 'Move or reorder a Document in the hierarchy, optionally under a new parent.'
	},
	'documents.deleteDocument': {
		mcp: true,
		ui: true,
		mcpToolName: 'delete_document',
		mcpDescription: 'Delete a Document and its child tree.'
	},
	'documents.updateDocumentTitle': { mcp: false, ui: true },
	// Not actually reachable from the UI: the Document route's own load
	// function (src/routes/space/[spaceId]/doc/[id]/+page.server.ts) reads
	// the title via the plain data-layer $lib/data/document-ops#getDocument,
	// not this service function — and the live block content the editor
	// renders comes from the browser's own real-time Yjs client, never a
	// synchronous, markdown-transcoded read. Discovered while implementing
	// the harness-driven UI-wiring test (issue #213) — corrected here rather
	// than left declaring a binding nothing exercises.
	'documents.getDocument': {
		mcp: true,
		ui: false,
		mcpToolName: 'get_document',
		mcpDescription: "Get a Document's ordered blocks, with content transcoded to Markdown."
	},
	'documents.listDocuments': {
		mcp: true,
		ui: true,
		mcpToolName: 'list_documents',
		mcpDescription: 'List Documents this connection has access to, including tree hierarchy.'
	},
	// UI-only for now (issue #83): the Document route's own load function
	// renders a Backlinks panel from this. Not MCP-exposed — #83's own scope
	// doesn't ask for an agent-facing surface, and this can be added later
	// without touching the function's own contract.
	'documents.listBacklinks': { mcp: false, ui: true },

	'records.createRecord': {
		mcp: true,
		ui: true,
		mcpToolName: 'create_record',
		mcpDescription:
			'Create a new block (in a Document) or row (in a Collection). No hold needed. `referencedRecordId` sets a page_link, child_pages, or collection_view block\'s target in the same call — only valid when blockType is one of those three, the parent is a Document, and the target is an accessible Document (page_link/child_pages) or Collection (collection_view); for child_pages and page_link it is optional (absent means "current Document"/"unconfigured link"), and so is collection_view\'s target (an unconfigured embed). `viewConfig` sets a collection_view block\'s view type + filters/sort/visible-properties/grouping (`groupBy`)/swimlane-grouping (`swimlaneBy`) config in the same call — only valid when blockType is "collection_view"; `viewType` ("table", "board", or "calendar") is required within it. `childPagesDepth` (a positive integer, or "unlimited") sets a child_pages block\'s nesting depth — only valid when blockType is "child_pages"; absent defaults to 1 (immediate children only). `columnCount` (an integer 2-6, default 2) sets a columns block\'s initial number of columns — only valid when blockType is "columns"; a columns block can only be created directly inside a Document, and each of its columns is itself a valid `parentId` for a following create_record call (blockType one of paragraph/heading_1-4/bulleted_list_item/numbered_list_item/to_do/quote/divider — the curated set a column can render) to populate it with content. To add another column (2-6 total), call create_record with blockType "column" and the columns block\'s own id as `parentId`.'
	},
	'records.writeRecord': {
		mcp: true,
		ui: true,
		mcpToolName: 'write_record',
		mcpDescription:
			"Write a record. `markdown` overwrites block content (requires an active hold); `properties` merges into a Collection row; `referencedRecordId` retargets an existing page_link block to a new, accessible Document, or an existing collection_view block to a new, accessible Collection (no hold needed, idempotent); `viewConfig` replaces an existing collection_view block's entire view configuration wholesale (no hold needed) — a member left out of the new value is cleared, not left as-is; `viewConfigPatch` instead merges only the named members into an already-configured collection_view block's view configuration, leaving every other member exactly as-is (no hold needed) — send a member as `null` to explicitly clear it, or omit it to leave it untouched; provide either `viewConfig` or `viewConfigPatch`, never both."
	},
	'records.deleteRecord': {
		mcp: true,
		ui: true,
		mcpToolName: 'delete_record',
		mcpDescription: 'Delete a record. No hold needed.'
	},
	// Not actually reachable from the UI: the block editor reads records via
	// the plain data-layer $lib/data/record-ops#getRecord against its own
	// live Yjs doc, never this service function. Discovered while
	// implementing the harness-driven UI-wiring test (issue #213).
	'records.getRecord': { mcp: false, ui: false },

	// Holds are an MCP/agent-only concept (collaboration.md): a human's
	// cursor is an *implicit* hold, conveyed only via Yjs Awareness — the UI
	// never issues an explicit hold_records/release_records call, or
	// anything equivalent to one. Nothing in src/routes calls either
	// function. Discovered while implementing the harness-driven UI-wiring
	// test (issue #213).
	'holds.holdRecords': {
		mcp: true,
		ui: false,
		mcpToolName: 'hold_records',
		mcpDescription:
			'Request a hold on a set of block/record IDs before writing — advisory, per-record.'
	},
	'holds.releaseRecords': {
		mcp: true,
		ui: false,
		mcpToolName: 'release_records',
		mcpDescription: 'Release a hold on a set of record IDs without writing.'
	},

	'collections.createCollection': { mcp: false, ui: true },
	'collections.listCollections': {
		mcp: true,
		ui: true,
		mcpToolName: 'list_collections',
		mcpDescription: 'List Collections this connection has access to.'
	},
	// Not actually reachable from the UI: the Table view's live grid was
	// always meant to read directly off Yjs observers (see the top-level
	// CLAUDE.md's persistence note), and the Collection route's own load
	// function (src/routes/space/[spaceId]/table/[id]/+page.server.ts) reads
	// only the title via the plain data-layer
	// $lib/data/collection-ops#getCollection — never this service function.
	// Discovered while implementing the harness-driven UI-wiring test
	// (issue #213).
	'collections.queryCollection': {
		mcp: true,
		ui: false,
		mcpToolName: 'query_collection',
		mcpDescription: 'Query rows from a Collection.'
	},
	'collections.deleteCollection': { mcp: false, ui: true },
	'collections.updateCollectionTitle': { mcp: false, ui: true },
	// A pure computation helper, not a command/query of its own — not bound to
	// any MCP tool or UI route, just callable directly (#191, so the MCP
	// handler for list_collections/query_collection doesn't need its own
	// import of $lib/data/records to resolve a Collection's primary field).
	'collections.resolvePrimaryFieldKey': { mcp: false, ui: false },

	// Not actually reachable from the UI: there is no search box or other
	// UI feature calling this today — it's exposed to MCP callers only.
	// Discovered while implementing the harness-driven UI-wiring test
	// (issue #213).
	'search.searchWorkspace': {
		mcp: true,
		ui: false,
		mcpToolName: 'search_workspace',
		mcpDescription:
			'Search all Documents and Collections the caller has access to, returning matching record IDs and short snippets.'
	},

	'spaces.createSpace': { mcp: false, ui: true },
	'spaces.listSpaces': { mcp: false, ui: true },
	'tokens.createToken': { mcp: false, ui: true },
	'tokens.revokeToken': { mcp: false, ui: true },
	'tokens.listTokens': { mcp: false, ui: true },
	'audit.listAuditHistory': { mcp: false, ui: true }
};

/**
 * Concrete adapter ownership. These maps are deliberately separate from
 * `serviceSurfaces`: a declaration without an adapter is a test failure, and
 * an adapter that has not declared its service method is equally invalid.
 */
export const mcpAdapterBindings = {
	'documents.createDocument': 'create_document',
	'documents.moveDocument': 'move_document',
	'documents.deleteDocument': 'delete_document',
	'documents.getDocument': 'get_document',
	'documents.listDocuments': 'list_documents',
	'records.createRecord': 'create_record',
	'records.writeRecord': 'write_record',
	'records.deleteRecord': 'delete_record',
	'holds.holdRecords': 'hold_records',
	'holds.releaseRecords': 'release_records',
	'collections.listCollections': 'list_collections',
	'collections.queryCollection': 'query_collection',
	'search.searchWorkspace': 'search_workspace'
} as const satisfies Partial<Record<ServiceMethod, string>>;

export const uiAdapterBindings = {
	'documents.createDocument': 'src/routes/api/documents/+server.ts',
	'documents.deleteDocument': 'src/routes/api/documents/[id]/+server.ts',
	// The route file, not +page.server.ts: the title edit is a direct
	// client-side Yjs mutation ($lib/data/document-ops#updateDocumentTitle),
	// audited by the server's generic audit observer as `update_document`
	// rather than this service function's own `update_document_title` —
	// see docs/specifications/audit-coverage.md.
	'documents.updateDocumentTitle': 'src/routes/space/[spaceId]/doc/[id]/+page.svelte',
	'documents.listDocuments': 'src/routes/+layout.server.ts',
	'documents.listBacklinks': 'src/routes/space/[spaceId]/doc/[id]/+page.server.ts',
	'records.createRecord': 'src/routes/space/[spaceId]/doc/[id]/+page.svelte',
	'records.writeRecord': 'src/routes/space/[spaceId]/doc/[id]/+page.svelte',
	'records.deleteRecord': 'src/routes/space/[spaceId]/doc/[id]/+page.svelte',
	'collections.createCollection': 'src/routes/api/collections/+server.ts',
	'collections.listCollections': 'src/routes/+layout.server.ts',
	'collections.deleteCollection': 'src/routes/api/collections/[id]/+server.ts',
	// Same shape as documents.updateDocumentTitle above:
	// $lib/data/collection-ops#updateCollectionTitle, audited as
	// `update_collection` by the observer.
	'collections.updateCollectionTitle': 'src/routes/space/[spaceId]/table/[id]/+page.svelte',
	'spaces.createSpace': 'src/routes/api/spaces/+server.ts',
	'spaces.listSpaces': 'src/routes/+layout.server.ts',
	'tokens.createToken': 'src/routes/settings/tokens/+page.server.ts',
	'tokens.revokeToken': 'src/routes/settings/tokens/+page.server.ts',
	'tokens.listTokens': 'src/routes/settings/tokens/+page.server.ts',
	'audit.listAuditHistory': 'src/routes/audit/+page.server.ts'
} as const satisfies Partial<Record<ServiceMethod, string>>;
