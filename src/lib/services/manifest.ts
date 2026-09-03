import * as documents from './documents';
import * as records from './records';
import * as holds from './holds';
import * as collections from './collections';
import * as search from './search';

export const serviceModules = { documents, records, holds, collections, search } as const;

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
	'documents.getDocument': {
		mcp: true,
		ui: true,
		mcpToolName: 'get_document',
		mcpDescription: "Get a Document's ordered blocks, with content transcoded to Markdown."
	},
	'documents.listDocuments': {
		mcp: true,
		ui: true,
		mcpToolName: 'list_documents',
		mcpDescription: 'List Documents this connection has access to, including tree hierarchy.'
	},

	'records.createRecord': {
		mcp: true,
		ui: true,
		mcpToolName: 'create_record',
		mcpDescription:
			'Create a new block (in a Document) or row (in a Collection). No hold needed. `referencedRecordId` sets a page_link, child_pages, or collection_view block\'s target in the same call — only valid when blockType is one of those three, the parent is a Document, and the target is an accessible Document (page_link/child_pages) or Collection (collection_view); for child_pages and page_link it is optional (absent means "current Document"/"unconfigured link"), and so is collection_view\'s target (an unconfigured embed). `viewConfig` sets a collection_view block\'s view type + filters/sort/visible-properties/grouping config in the same call — only valid when blockType is "collection_view"; `viewType` ("table", "board", or "calendar") is required within it. `childPagesDepth` (a positive integer, or "unlimited") sets a child_pages block\'s nesting depth — only valid when blockType is "child_pages"; absent defaults to 1 (immediate children only).'
	},
	'records.writeRecord': {
		mcp: true,
		ui: true,
		mcpToolName: 'write_record',
		mcpDescription:
			"Write a record. `markdown` overwrites block content (requires an active hold); `properties` merges into a Collection row; `referencedRecordId` retargets an existing page_link block to a new, accessible Document, or an existing collection_view block to a new, accessible Collection (no hold needed, idempotent); `viewConfig` replaces an existing collection_view block's entire view configuration wholesale (no hold needed) — a member left out of the new value is cleared, not left as-is."
	},
	'records.deleteRecord': {
		mcp: true,
		ui: true,
		mcpToolName: 'delete_record',
		mcpDescription: 'Delete a record. No hold needed.'
	},
	'records.getRecord': { mcp: false, ui: true },

	'holds.holdRecords': {
		mcp: true,
		ui: true,
		mcpToolName: 'hold_records',
		mcpDescription:
			'Request a hold on a set of block/record IDs before writing — advisory, per-record.'
	},
	'holds.releaseRecords': {
		mcp: true,
		ui: true,
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
	'collections.queryCollection': {
		mcp: true,
		ui: true,
		mcpToolName: 'query_collection',
		mcpDescription: 'Query rows from a Collection.'
	},
	'collections.deleteCollection': { mcp: false, ui: true },
	'collections.updateCollectionTitle': { mcp: false, ui: true },

	'search.searchWorkspace': {
		mcp: true,
		ui: true,
		mcpToolName: 'search_workspace',
		mcpDescription:
			'Search all Documents and Collections the caller has access to, returning matching record IDs and short snippets.'
	}
};
