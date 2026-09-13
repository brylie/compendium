import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import packageJson from '../../../package.json' with { type: 'json' };
import { verifyToken, type AccessToken } from './tokens';
import { resolveRequestContext, type RequestContext } from '$lib/server/request-context';
import {
	serviceModules,
	serviceSurfaces,
	mcpAdapterBindings,
	resolvePrimaryFieldKey,
	type ServiceMethod,
	PermissionDeniedError,
	HoldRequiredError
} from '$lib/services';
import {
	blockTypes,
	propertyTypes,
	type BlockType,
	type EmbeddedViewConfig,
	type ViewConfig
} from '$lib/data/types';
import { projectDocument } from './document-projection';

const propertyValueSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal(propertyTypes[0]), value: z.string() }),
	z.object({ type: z.literal(propertyTypes[1]), value: z.number() }),
	z.object({ type: z.literal(propertyTypes[2]), value: z.string() }),
	z.object({ type: z.literal(propertyTypes[3]), value: z.string() }),
	z.object({ type: z.literal(propertyTypes[4]), value: z.boolean() }),
	z.object({ type: z.literal(propertyTypes[5]), value: z.array(z.string()) })
]);

const blockTypeSchema = z.enum(blockTypes);

const childPagesDepthSchema = z.union([z.number().int().positive(), z.literal('unlimited')]);

// Mirrors ViewConfig's own members ($lib/data/types.ts) — shared between
// viewConfigSchema (whole-value, viewType required) and viewConfigPatchSchema
// (per-member merge, issue #195) below.
const viewFiltersSchema = z.array(
	z.object({
		propertyKey: z.string(),
		op: z.enum(['is', 'is_not', 'is_empty', 'is_not_empty']),
		value: z.string().optional()
	})
);
const viewSortSchema = z.object({
	mode: z.enum(['manual', 'property']),
	propertyKey: z.string().optional(),
	direction: z.enum(['asc', 'desc']).optional()
});
const viewSummariesSchema = z.record(
	z.string(),
	z.enum([
		'none',
		'count_all',
		'count_values',
		'count_empty',
		'sum',
		'average',
		'min',
		'max',
		'earliest',
		'latest',
		'checked',
		'unchecked'
	])
);

// Mirrors EmbeddedViewConfig ($lib/data/types.ts) field-for-field — see
// collection-views.md §2/§9 for what each member means.
const viewConfigSchema = z.object({
	viewType: z.enum(['table', 'board', 'calendar']),
	filters: viewFiltersSchema.optional(),
	sort: viewSortSchema.optional(),
	visibleProperties: z.array(z.string()).optional(),
	groupBy: z.string().optional(),
	swimlaneBy: z.string().optional(),
	summaries: viewSummariesSchema.optional()
});

// write_record's per-member counterpart to viewConfigSchema (issue #195): no
// `viewType` (a patch can't change it — see patchRecordViewConfig's own doc
// comment in $lib/data/record-ops.ts), and each member is nullable so a
// caller can explicitly clear it (`null`) as distinct from leaving it
// untouched (omitted) — JSON has no way to send "the key undefined", the
// distinction patchRecordViewConfig's Partial<ViewConfig> patch relies on, so
// `null` stands in for it here and normalizeViewConfigPatch below converts it
// back before this reaches the service layer.
const viewConfigPatchSchema = z.object({
	filters: viewFiltersSchema.nullable().optional(),
	sort: viewSortSchema.nullable().optional(),
	visibleProperties: z.array(z.string()).nullable().optional(),
	groupBy: z.string().nullable().optional(),
	swimlaneBy: z.string().nullable().optional(),
	summaries: viewSummariesSchema.nullable().optional()
});

/**
 * Converts a parsed viewConfigPatchSchema object into the `Partial<ViewConfig>` the service
 * layer expects — a member explicitly sent as `null` becomes `undefined` (clear it), a member
 * omitted from the call stays absent from the result entirely (leave it untouched). Relies on
 * `Object.keys`/spread preserving an explicitly-assigned `undefined` value as a present key,
 * which is what lets patchRecordViewConfig ($lib/data/record-ops.ts) tell "clear this member"
 * apart from "don't mention it".
 */
function normalizeViewConfigPatch(
	patch: z.infer<typeof viewConfigPatchSchema> | undefined
): Partial<ViewConfig> | undefined {
	if (!patch) return undefined;
	const normalized: Partial<ViewConfig> = {};
	if ('filters' in patch) normalized.filters = patch.filters ?? undefined;
	if ('sort' in patch) normalized.sort = patch.sort ?? undefined;
	if ('visibleProperties' in patch)
		normalized.visibleProperties = patch.visibleProperties ?? undefined;
	if ('groupBy' in patch) normalized.groupBy = patch.groupBy ?? undefined;
	if ('swimlaneBy' in patch) normalized.swimlaneBy = patch.swimlaneBy ?? undefined;
	if ('summaries' in patch) normalized.summaries = patch.summaries ?? undefined;
	return normalized;
}

function textResult(data: unknown): CallToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
	return { content: [{ type: 'text', text: message }], isError: true };
}

interface McpAuthExtra {
	authInfo?: { token?: string };
}

function registerFromManifest<Args extends z.ZodRawShape>(
	server: McpServer,
	method: ServiceMethod,
	inputSchema: Args,
	handler: (args: z.infer<z.ZodObject<Args>>, extra: McpAuthExtra) => Promise<CallToolResult>
): void {
	const surface = serviceSurfaces[method];
	if (!surface.mcp || !surface.mcpToolName || !surface.mcpDescription) {
		throw new Error(
			`Service method "${method}" is not declared as an MCP tool with valid name and description in manifest`
		);
	}
	if (mcpAdapterBindings[method as keyof typeof mcpAdapterBindings] !== surface.mcpToolName) {
		throw new Error(`MCP adapter binding for service method "${method}" is missing or mismatched`);
	}
	const register = server.registerTool.bind(server) as (
		name: string,
		config: { description?: string; inputSchema: Args },
		callback: (args: z.infer<z.ZodObject<Args>>, extra: McpAuthExtra) => Promise<CallToolResult>
	) => void;

	register(
		surface.mcpToolName,
		{
			description: surface.mcpDescription,
			inputSchema
		},
		handler
	);
}

/** Builds a fresh McpServer with all Phase 0/1 tools registered from serviceSurfaces manifest (service-layer-manifest-specification.md §3.1). */
export function createMcpServer(): McpServer {
	const server = new McpServer({ name: 'compendium', version: packageJson.version });

	// 1. documents.listDocuments
	registerFromManifest(server, 'documents.listDocuments', {}, async (_args, extra) => {
		try {
			const context = requireContext(extra);
			const docs = serviceModules.documents.listDocuments(context).map((d) => ({
				id: d.id,
				title: d.title,
				parentDocumentId: d.parentDocumentId,
				order: d.order
			}));
			return textResult(docs);
		} catch (err) {
			return handleToolError(err);
		}
	});

	// 2. documents.getDocument
	registerFromManifest(
		server,
		'documents.getDocument',
		{ documentId: z.string() },
		async ({ documentId }, extra) => {
			try {
				const context = requireContext(extra);
				const result = serviceModules.documents.getDocument(context, documentId);
				if (!result) return errorResult(`Document ${documentId} not found`);
				return textResult(projectDocument(context, documentId, result));
			} catch (err) {
				return handleToolError(err);
			}
		}
	);

	// 3. documents.createDocument
	registerFromManifest(
		server,
		'documents.createDocument',
		{
			title: z.string(),
			parentDocumentId: z.string().optional()
		},
		async ({ title, parentDocumentId }, extra) => {
			try {
				const context = requireContext(extra);
				const document = serviceModules.documents.createDocument(context, {
					title,
					parentDocumentId
				});
				return textResult({
					id: document.id,
					title: document.title,
					parentDocumentId: document.parentDocumentId
				});
			} catch (err) {
				return handleToolError(err);
			}
		}
	);

	// 4. documents.moveDocument
	registerFromManifest(
		server,
		'documents.moveDocument',
		{
			documentId: z.string(),
			parentDocumentId: z.string().optional(),
			afterDocumentId: z.string().optional()
		},
		async ({ documentId, parentDocumentId, afterDocumentId }, extra) => {
			try {
				const context = requireContext(extra);
				serviceModules.documents.moveDocument(context, documentId, {
					parentDocumentId,
					afterDocumentId
				});
				return textResult({
					success: true,
					documentId,
					parentDocumentId
				});
			} catch (err) {
				return handleToolError(err);
			}
		}
	);

	// 5. documents.deleteDocument
	registerFromManifest(
		server,
		'documents.deleteDocument',
		{ documentId: z.string() },
		async ({ documentId }, extra) => {
			try {
				const context = requireContext(extra);
				serviceModules.documents.deleteDocument(context, documentId);
				return textResult({ success: true, documentId });
			} catch (err) {
				return handleToolError(err);
			}
		}
	);

	// 6. collections.listCollections
	registerFromManifest(server, 'collections.listCollections', {}, async (_args, extra) => {
		try {
			const context = requireContext(extra);
			const collections = serviceModules.collections.listCollections(context).map((c) => ({
				id: c.id,
				title: c.title,
				schema: c.schema,
				primaryFieldKey: resolvePrimaryFieldKey(c.schema, c.primaryFieldKey)
			}));
			return textResult(collections);
		} catch (err) {
			return handleToolError(err);
		}
	});

	// 7. collections.queryCollection
	registerFromManifest(
		server,
		'collections.queryCollection',
		{
			collectionId: z.string(),
			filter: viewFiltersSchema
				.optional()
				.describe(
					"Keeps only rows matching every filter — the same semantics a human Table/Board/Calendar view applies (see write_record's viewConfig.filters)."
				)
		},
		async ({ collectionId, filter }, extra) => {
			try {
				const context = requireContext(extra);
				const { collection, records } = serviceModules.collections.queryCollection(
					context,
					collectionId,
					filter
				);
				if (!collection) return errorResult(`Collection ${collectionId} not found`);

				const rows = records.map((r) => ({
					id: r.id,
					properties: r.properties ?? {}
				}));
				return textResult({
					id: collection.id,
					title: collection.title,
					schema: collection.schema,
					primaryFieldKey: resolvePrimaryFieldKey(collection.schema, collection.primaryFieldKey),
					rows
				});
			} catch (err) {
				return handleToolError(err);
			}
		}
	);

	// 8. search.searchWorkspace
	registerFromManifest(
		server,
		'search.searchWorkspace',
		{
			query: z.string(),
			space_id: z
				.string()
				.optional()
				.describe(
					'Restrict results to one Space. Omitted, searches every Space in the workspace (current default behavior).'
				)
		},
		async ({ query, space_id }, extra) => {
			try {
				const context = requireContext(extra);
				const results = serviceModules.search.searchWorkspace(context, query, space_id);
				return textResult(results);
			} catch (err) {
				return handleToolError(err);
			}
		}
	);

	// 9. holds.holdRecords
	registerFromManifest(
		server,
		'holds.holdRecords',
		{ recordIds: z.array(z.string()) },
		async ({ recordIds }, extra) => {
			try {
				const context = requireContext(extra);
				const result = serviceModules.holds.holdRecords(context, recordIds);
				return textResult(result);
			} catch (err) {
				return handleToolError(err);
			}
		}
	);

	// 10. holds.releaseRecords
	registerFromManifest(
		server,
		'holds.releaseRecords',
		{ recordIds: z.array(z.string()) },
		async ({ recordIds }, extra) => {
			try {
				const context = requireContext(extra);
				serviceModules.holds.releaseRecords(context, recordIds);
				return textResult({ success: true });
			} catch (err) {
				return handleToolError(err);
			}
		}
	);

	// 11. records.writeRecord
	registerFromManifest(
		server,
		'records.writeRecord',
		{
			recordId: z.string(),
			markdown: z.string().optional(),
			properties: z.record(z.string(), propertyValueSchema).optional(),
			referencedRecordId: z.string().optional(),
			viewConfig: viewConfigSchema.optional(),
			viewConfigPatch: viewConfigPatchSchema.optional()
		},
		async (
			{ recordId, markdown, properties, referencedRecordId, viewConfig, viewConfigPatch },
			extra
		) => {
			try {
				const context = requireContext(extra);
				serviceModules.records.writeRecord(context, recordId, {
					markdown,
					properties,
					referencedRecordId,
					viewConfig: viewConfig as EmbeddedViewConfig | undefined,
					viewConfigPatch: normalizeViewConfigPatch(viewConfigPatch)
				});
				return textResult({ success: true });
			} catch (err) {
				return handleToolError(err);
			}
		}
	);

	// 12. records.createRecord
	registerFromManifest(
		server,
		'records.createRecord',
		{
			parentId: z.string(),
			afterRecordId: z.string().optional(),
			blockType: blockTypeSchema.optional(),
			properties: z.record(z.string(), propertyValueSchema).optional(),
			referencedRecordId: z.string().optional(),
			viewConfig: viewConfigSchema.optional(),
			childPagesDepth: childPagesDepthSchema.optional(),
			columnCount: z.number().int().optional()
		},
		async (
			{
				parentId,
				afterRecordId,
				blockType,
				properties,
				referencedRecordId,
				viewConfig,
				childPagesDepth,
				columnCount
			},
			extra
		) => {
			try {
				const context = requireContext(extra);
				const record = serviceModules.records.createRecord(context, {
					parentId,
					afterRecordId,
					blockType: blockType as BlockType | undefined,
					properties,
					referencedRecordId,
					viewConfig: viewConfig as EmbeddedViewConfig | undefined,
					childPagesDepth,
					columnCount
				});
				return textResult({ recordId: record.id });
			} catch (err) {
				return handleToolError(err);
			}
		}
	);

	// 13. records.deleteRecord
	registerFromManifest(
		server,
		'records.deleteRecord',
		{ recordId: z.string() },
		async ({ recordId }, extra) => {
			try {
				const context = requireContext(extra);
				serviceModules.records.deleteRecord(context, recordId);
				return textResult({ success: true });
			} catch (err) {
				return handleToolError(err);
			}
		}
	);

	// 14. blockTypes.listBlockTypes
	registerFromManifest(server, 'blockTypes.listBlockTypes', {}, async (_args, extra) => {
		try {
			requireToken(extra);
			return textResult(serviceModules.blockTypes.listBlockTypes());
		} catch (err) {
			return handleToolError(err);
		}
	});

	return server;
}

function requireToken(extra: { authInfo?: { token?: string } }): AccessToken {
	const raw = extra.authInfo?.token;
	if (!raw) throw new PermissionDeniedError('Missing bearer token');
	const token = verifyToken(raw);
	if (!token) throw new PermissionDeniedError('Invalid or revoked access token');
	return token;
}

/** Resolves the trusted RequestContext for one MCP tool call, from its bearer token — each call resolves its own independently, per hooks.server.ts's own doc comment. */
function requireContext(extra: { authInfo?: { token?: string } }): RequestContext {
	return resolveRequestContext(requireToken(extra));
}

function handleToolError(err: unknown): CallToolResult {
	if (err instanceof PermissionDeniedError) return errorResult(`Permission denied: ${err.message}`);
	if (err instanceof HoldRequiredError) return errorResult(err.message);
	return errorResult(err instanceof Error ? err.message : String(err));
}
