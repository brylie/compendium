import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { getYDoc } from '$lib/server/ydoc';
import { getAwareness } from '$lib/server/awareness';
import {
	clientIdForToken,
	isHeldByClient,
	releaseAgentHold,
	requestAgentHold
} from '$lib/server/holds';
import { logAudit } from '$lib/server/audit';
import {
	createDocument,
	createRecord,
	deleteRecord,
	getDocument,
	getRecord,
	getRecordYText,
	listCollections,
	listDocuments,
	listRecordsForParent,
	updateDocumentParent,
	updateRecordContent,
	updateRecordProperties
} from '$lib/data/records';
import { yTextToRichText } from '$lib/data/richtext';
import { markdownToRichText, richTextToMarkdown } from './markdown-transcode';
import { grantDocumentAccess, tokenAllowsParent, verifyToken, type AccessToken } from './tokens';
import type { ActorId, BlockType } from '$lib/data/types';

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
	'heading',
	'heading_1',
	'heading_2',
	'heading_3',
	'heading_4',
	'bulleted_list_item',
	'numbered_list_item',
	'list-item',
	'to_do',
	'quote',
	'divider',
	'callout',
	'toggle',
	'table',
	'code',
	'table_of_contents',
	'synced_block',
	'page-link',
	'page_link',
	'embed'
]);

function actorForToken(token: AccessToken): ActorId {
	return { kind: 'human-via-client', userId: 'local', client: token.clientLabel };
}

function textResult(data: unknown): CallToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
	return { content: [{ type: 'text', text: message }], isError: true };
}

class PermissionDenied extends Error {}

function requireAccessibleParent(token: AccessToken, parentId: string): void {
	if (!tokenAllowsParent(token, parentId)) {
		throw new PermissionDenied(`Not permitted to access parent ${parentId}`);
	}
}

function requireAccessibleRecord(
	token: AccessToken,
	recordId: string
): ReturnType<typeof getRecord> {
	const doc = getYDoc();
	const record = getRecord(doc, recordId);
	if (!record) throw new PermissionDenied(`Record ${recordId} not found`);
	requireAccessibleParent(token, record.parentId);
	return record;
}

/** Builds a fresh McpServer with all Phase 0 tools registered (technical-design.md §5). */
export function createAgentSpaceMcpServer(): McpServer {
	const server = new McpServer({ name: 'agentspace', version: '0.1.0' });

	server.registerTool(
		'list_documents',
		{
			description: 'List Documents this connection has access to, including tree hierarchy.',
			inputSchema: {}
		},
		async (_args, extra) => {
			try {
				const token = requireToken(extra);
				const doc = getYDoc();
				const docs = listDocuments(doc)
					.filter((d) => tokenAllowsParent(token, d.id))
					.map((d) => ({
						id: d.id,
						title: d.title,
						parentDocumentId: d.parentDocumentId,
						order: d.order
					}));
				return textResult(docs);
			} catch (err) {
				return handleToolError(err);
			}
		}
	);

	server.registerTool(
		'get_document',
		{
			description: "Get a Document's ordered blocks, with content transcoded to Markdown.",
			inputSchema: { documentId: z.string() }
		},
		async ({ documentId }, extra) => {
			try {
				const token = requireToken(extra);
				requireAccessibleParent(token, documentId);
				const doc = getYDoc();
				const document = getDocument(doc, documentId);
				if (!document) return errorResult(`Document ${documentId} not found`);

				const records = listRecordsForParent(doc, documentId).map((r) => ({
					id: r.id,
					blockType: r.blockType,
					checked: r.checked,
					collapsed: r.collapsed,
					referencedRecordId: r.referencedRecordId,
					markdown: r.content ? richTextToMarkdown(doc, r.content) : ''
				}));

				logAudit({
					actor: actorForToken(token),
					action: 'get_document',
					targetRecordId: documentId
				});
				return textResult({
					id: document.id,
					title: document.title,
					parentDocumentId: document.parentDocumentId,
					records
				});
			} catch (err) {
				return handleToolError(err);
			}
		}
	);

	server.registerTool(
		'create_document',
		{
			description: 'Create a new Document, optionally nested under an accessible parent Document.',
			inputSchema: {
				title: z.string(),
				parentDocumentId: z.string().optional()
			}
		},
		async ({ title, parentDocumentId }, extra) => {
			try {
				const token = requireToken(extra);
				// Decision: In single-tenant Phase 0/1, any authenticated bearer token is permitted
				// to create top-level documents; when nested, access to parentDocumentId is verified.
				if (parentDocumentId) {
					requireAccessibleParent(token, parentDocumentId);
				}
				const doc = getYDoc();
				const actor = actorForToken(token);
				const document = createDocument(doc, { title, parentDocumentId });

				// Persist access grant in SQLite so future tool calls from this token succeed
				grantDocumentAccess(token.tokenHash, document.id);
				token.allowedDocumentIds.push(document.id);

				logAudit({ actor, action: 'create_document', targetRecordId: document.id });
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

	server.registerTool(
		'move_document',
		{
			description: 'Move or reorder a Document in the hierarchy, optionally under a new parent.',
			inputSchema: {
				documentId: z.string(),
				parentDocumentId: z.string().optional(),
				afterDocumentId: z.string().optional()
			}
		},
		async ({ documentId, parentDocumentId, afterDocumentId }, extra) => {
			try {
				const token = requireToken(extra);
				requireAccessibleParent(token, documentId);
				if (parentDocumentId) {
					requireAccessibleParent(token, parentDocumentId);
				}
				const doc = getYDoc();
				const actor = actorForToken(token);
				updateDocumentParent(doc, documentId, parentDocumentId, afterDocumentId);
				logAudit({
					actor,
					action: 'move_document',
					targetRecordId: documentId,
					diff: { parentDocumentId, afterDocumentId }
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

	server.registerTool(
		'list_collections',
		{
			description: 'List Collections this connection has access to.',
			inputSchema: {}
		},
		async (_args, extra) => {
			try {
				const token = requireToken(extra);
				const doc = getYDoc();
				const collections = listCollections(doc)
					.filter((c) => tokenAllowsParent(token, c.id))
					.map((c) => ({ id: c.id, title: c.title, schema: c.schema }));
				return textResult(collections);
			} catch (err) {
				return handleToolError(err);
			}
		}
	);

	server.registerTool(
		'query_collection',
		{
			description:
				"Query a Collection's rows. `filter` is simple property-equality for Phase 0 (key -> scalar value), not a general query language.",
			inputSchema: {
				collectionId: z.string(),
				filter: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
			}
		},
		async ({ collectionId, filter }, extra) => {
			try {
				const token = requireToken(extra);
				requireAccessibleParent(token, collectionId);
				const doc = getYDoc();
				let rows = listRecordsForParent(doc, collectionId);
				if (filter) {
					rows = rows.filter((row) =>
						Object.entries(filter).every(([key, value]) => row.properties?.[key]?.value === value)
					);
				}
				logAudit({
					actor: actorForToken(token),
					action: 'query_collection',
					targetRecordId: collectionId
				});
				return textResult(rows);
			} catch (err) {
				return handleToolError(err);
			}
		}
	);

	server.registerTool(
		'search_workspace',
		{
			description:
				'Full-text search over block content and text/select property values, scoped to accessible parents.',
			inputSchema: { query: z.string() }
		},
		async ({ query }, extra) => {
			try {
				const token = requireToken(extra);
				const doc = getYDoc();
				const needle = query.toLowerCase();
				const results: { recordId: string; snippet: string }[] = [];

				for (const document of listDocuments(doc)) {
					if (!tokenAllowsParent(token, document.id)) continue;
					for (const record of listRecordsForParent(doc, document.id)) {
						const text = record.content ? richTextToMarkdown(doc, record.content) : '';
						if (text.toLowerCase().includes(needle)) {
							results.push({ recordId: record.id, snippet: snippetAround(text, needle) });
						}
					}
				}
				for (const collection of listCollections(doc)) {
					if (!tokenAllowsParent(token, collection.id)) continue;
					for (const row of listRecordsForParent(doc, collection.id)) {
						for (const value of Object.values(row.properties ?? {})) {
							const text = value.type === 'text' || value.type === 'select' ? value.value : '';
							if (text.toLowerCase().includes(needle)) {
								results.push({ recordId: row.id, snippet: snippetAround(text, needle) });
								break;
							}
						}
					}
				}

				return textResult(results);
			} catch (err) {
				return handleToolError(err);
			}
		}
	);

	server.registerTool(
		'hold_records',
		{
			description:
				'Request a hold on a set of block/record IDs before writing — advisory, per-record (not all-or-nothing). Required before write_record on existing block content.',
			inputSchema: { recordIds: z.array(z.string()) }
		},
		async ({ recordIds }, extra) => {
			try {
				const token = requireToken(extra);
				const doc = getYDoc();
				const awareness = getAwareness();
				const clientId = clientIdForToken(token.tokenHash);
				const result = requestAgentHold(
					awareness,
					clientId,
					actorForToken(token),
					recordIds,
					(id) => {
						const record = getRecord(doc, id);
						return record ? tokenAllowsParent(token, record.parentId) : false;
					}
				);
				logAudit({ actor: actorForToken(token), action: 'hold_records', diff: result });
				return textResult(result);
			} catch (err) {
				return handleToolError(err);
			}
		}
	);

	server.registerTool(
		'release_records',
		{
			description: 'Release a hold on a set of record IDs without writing.',
			inputSchema: { recordIds: z.array(z.string()) }
		},
		async ({ recordIds }, extra) => {
			try {
				const token = requireToken(extra);
				const awareness = getAwareness();
				const clientId = clientIdForToken(token.tokenHash);
				releaseAgentHold(awareness, clientId, recordIds);
				logAudit({ actor: actorForToken(token), action: 'release_records', diff: { recordIds } });
				return textResult({ success: true });
			} catch (err) {
				return handleToolError(err);
			}
		}
	);

	server.registerTool(
		'write_record',
		{
			description:
				'Write a record. `markdown` overwrites block content (requires an active hold acquired via hold_records) and is transcoded from GFM+extensions. `properties` merges into a Collection row and needs no hold.',
			inputSchema: {
				recordId: z.string(),
				markdown: z.string().optional(),
				properties: z.record(z.string(), propertyValueSchema).optional()
			}
		},
		async ({ recordId, markdown, properties }, extra) => {
			try {
				const token = requireToken(extra);
				const record = requireAccessibleRecord(token, recordId);
				if (!record) return errorResult(`Record ${recordId} not found`);
				const actor = actorForToken(token);
				const doc = getYDoc();

				if (markdown !== undefined) {
					const awareness = getAwareness();
					const clientId = clientIdForToken(token.tokenHash);
					if (!isHeldByClient(awareness, clientId, recordId)) {
						return errorResult(
							`No active hold on ${recordId} — call hold_records first, then retry (the hold may have been released by a concurrent human edit).`
						);
					}
					const richText = markdownToRichText(doc, markdown);
					const before = getRecordYText(doc, recordId)
						? yTextToRichText(getRecordYText(doc, recordId)!)
						: undefined;
					updateRecordContent(doc, recordId, richText, actor);
					releaseAgentHold(awareness, clientId, [recordId]);
					logAudit({
						actor,
						action: 'write_record',
						targetRecordId: recordId,
						diff: { before, after: richText }
					});
				}

				if (properties) {
					updateRecordProperties(doc, recordId, properties, actor);
					logAudit({
						actor,
						action: 'write_record',
						targetRecordId: recordId,
						diff: { properties }
					});
				}

				if (markdown === undefined && !properties) {
					return errorResult('write_record requires markdown or properties');
				}

				return textResult({ success: true });
			} catch (err) {
				return handleToolError(err);
			}
		}
	);

	server.registerTool(
		'create_record',
		{
			description:
				'Create a new block (in a Document) or row (in a Collection). No hold needed — no prior content to protect.',
			inputSchema: {
				parentId: z.string(),
				afterRecordId: z.string().optional(),
				blockType: blockTypeSchema.optional(),
				properties: z.record(z.string(), propertyValueSchema).optional()
			}
		},
		async ({ parentId, afterRecordId, blockType, properties }, extra) => {
			try {
				const token = requireToken(extra);
				requireAccessibleParent(token, parentId);
				const doc = getYDoc();
				const actor = actorForToken(token);
				const record = createRecord(
					doc,
					{ parentId, afterRecordId, blockType: blockType as BlockType | undefined, properties },
					actor
				);
				logAudit({ actor, action: 'create_record', targetRecordId: record.id });
				return textResult({ recordId: record.id });
			} catch (err) {
				return handleToolError(err);
			}
		}
	);

	server.registerTool(
		'delete_record',
		{
			description: 'Delete a record. No hold needed.',
			inputSchema: { recordId: z.string() }
		},
		async ({ recordId }, extra) => {
			try {
				const token = requireToken(extra);
				requireAccessibleRecord(token, recordId);
				const doc = getYDoc();
				deleteRecord(doc, recordId);
				logAudit({
					actor: actorForToken(token),
					action: 'delete_record',
					targetRecordId: recordId
				});
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
	if (!raw) throw new PermissionDenied('Missing bearer token');
	const token = verifyToken(raw);
	if (!token) throw new PermissionDenied('Invalid or revoked access token');
	return token;
}

function handleToolError(err: unknown): CallToolResult {
	if (err instanceof PermissionDenied) return errorResult(`Permission denied: ${err.message}`);
	return errorResult(err instanceof Error ? err.message : String(err));
}

function snippetAround(text: string, needle: string): string {
	const index = text.toLowerCase().indexOf(needle);
	if (index === -1) return text.slice(0, 80);
	const start = Math.max(0, index - 30);
	const end = Math.min(text.length, index + needle.length + 30);
	return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
