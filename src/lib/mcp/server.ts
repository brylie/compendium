import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { verifyToken, type AccessToken } from './tokens';
import {
	serviceModules,
	serviceSurfaces,
	type ServiceMethod,
	PermissionDeniedError,
	HoldRequiredError
} from '$lib/services';
import type { BlockType } from '$lib/data/types';

const propertyValueSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('text'), value: z.string() }),
	z.object({ type: z.literal('number'), value: z.number() }),
	z.object({ type: z.literal('date'), value: z.string() }),
	z.object({ type: z.literal('select'), value: z.string() }),
	z.object({ type: z.literal('checkbox'), value: z.boolean() }),
	z.object({ type: z.literal('relation'), value: z.array(z.string()) })
]);

const blockTypeSchema = z.enum([
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
	'embed'
]);

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
	const server = new McpServer({ name: 'compendium', version: '0.1.0' });

	// 1. documents.listDocuments
	registerFromManifest(server, 'documents.listDocuments', {}, async (_args, extra) => {
		try {
			const token = requireToken(extra);
			const docs = serviceModules.documents.listDocuments(token).map((d) => ({
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
				const token = requireToken(extra);
				const result = serviceModules.documents.getDocument(token, documentId);
				if (!result) return errorResult(`Document ${documentId} not found`);
				return textResult(result);
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
				const token = requireToken(extra);
				const document = serviceModules.documents.createDocument(token, {
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
				const token = requireToken(extra);
				serviceModules.documents.moveDocument(token, documentId, {
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
				const token = requireToken(extra);
				serviceModules.documents.deleteDocument(token, documentId);
				return textResult({ success: true, documentId });
			} catch (err) {
				return handleToolError(err);
			}
		}
	);

	// 6. collections.listCollections
	registerFromManifest(server, 'collections.listCollections', {}, async (_args, extra) => {
		try {
			const token = requireToken(extra);
			const collections = serviceModules.collections.listCollections(token).map((c) => ({
				id: c.id,
				title: c.title,
				schema: c.schema
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
			filter: z.unknown().optional()
		},
		async ({ collectionId }, extra) => {
			try {
				const token = requireToken(extra);
				const { collection, records } = serviceModules.collections.queryCollection(
					token,
					collectionId
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
		{ query: z.string() },
		async ({ query }, extra) => {
			try {
				const token = requireToken(extra);
				const results = serviceModules.search.searchWorkspace(token, query);
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
				const token = requireToken(extra);
				const result = serviceModules.holds.holdRecords(token, recordIds);
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
				const token = requireToken(extra);
				serviceModules.holds.releaseRecords(token, recordIds);
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
			properties: z.record(z.string(), propertyValueSchema).optional()
		},
		async ({ recordId, markdown, properties }, extra) => {
			try {
				const token = requireToken(extra);
				serviceModules.records.writeRecord(token, recordId, { markdown, properties });
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
			properties: z.record(z.string(), propertyValueSchema).optional()
		},
		async ({ parentId, afterRecordId, blockType, properties }, extra) => {
			try {
				const token = requireToken(extra);
				const record = serviceModules.records.createRecord(token, {
					parentId,
					afterRecordId,
					blockType: blockType as BlockType | undefined,
					properties
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
				const token = requireToken(extra);
				serviceModules.records.deleteRecord(token, recordId);
				return textResult({ success: true });
			} catch (err) {
				return handleToolError(err);
			}
		}
	);

	return server;
}

function requireToken(extra: { authInfo?: { token?: string } }): AccessToken {
	const raw = extra.authInfo?.token;
	if (!raw) throw new PermissionDeniedError('Missing bearer token');
	const token = verifyToken(raw);
	if (!token) throw new PermissionDeniedError('Invalid or revoked access token');
	return token;
}

function handleToolError(err: unknown): CallToolResult {
	if (err instanceof PermissionDeniedError) return errorResult(`Permission denied: ${err.message}`);
	if (err instanceof HoldRequiredError) return errorResult(err.message);
	return errorResult(err instanceof Error ? err.message : String(err));
}
