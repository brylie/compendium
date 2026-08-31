import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import {
	listCollections,
	listDocuments as crdtListDocuments,
	listRecordsForParent
} from '$lib/data/records';
import { logAudit } from '$lib/server/audit';
import {
	listCatalogCollections,
	listCatalogDocuments,
	resolveShardForParent
} from '$lib/server/catalog';
import { tokenAllowsParent } from '$lib/mcp/tokens';
import { richTextToMarkdown } from '$lib/mcp/markdown-transcode';
import { actorForCaller, isAccessToken, type CallerIdentity } from './permissions';

function snippetAround(text: string, needle: string): string {
	const index = text.toLowerCase().indexOf(needle);
	if (index === -1) return text.slice(0, 80);
	const start = Math.max(0, index - 30);
	const end = Math.min(text.length, index + needle.length + 30);
	return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export function searchWorkspace(
	caller: CallerIdentity,
	query: string
): Array<{ recordId: string; snippet: string }> {
	const { doc, workspaceId } = resolveWorkspaceContext();
	const actor = actorForCaller(caller);
	const needle = query.toLowerCase();
	const results: Array<{ recordId: string; snippet: string }> = [];

	function searchDocumentRecords(documentId: string, documentDoc: typeof doc): void {
		for (const record of listRecordsForParent(documentDoc, documentId)) {
			const text = record.content ? richTextToMarkdown(documentDoc, record.content) : '';
			if (text.toLowerCase().includes(needle)) {
				results.push({ recordId: record.id, snippet: snippetAround(text, needle) });
			}
		}
	}

	// Catalog-listed Documents first — resolving each one's own shard from the
	// locator (#120: each Document now has its own shard, same as Collections
	// already did), since listDocuments(doc) below could never see one that
	// lives outside the default doc.
	const catalogDocumentIds = new Set<string>();
	for (const documentMeta of listCatalogDocuments(workspaceId)) {
		catalogDocumentIds.add(documentMeta.id);
		if (isAccessToken(caller) && !tokenAllowsParent(caller, documentMeta.id)) continue;
		const shard = resolveShardForParent(workspaceId, documentMeta.id);
		const documentDoc = shard
			? resolveWorkspaceContext({ workspaceId, shardId: shard.shardId }).doc
			: doc;
		searchDocumentRecords(documentMeta.id, documentDoc);
	}

	// Then any Document written directly to the Y.Doc, bypassing the service
	// layer entirely (and therefore uncataloged) — only findable via the
	// default doc directly, matching the Collection loop's identical fallback
	// below.
	for (const document of crdtListDocuments(doc)) {
		if (catalogDocumentIds.has(document.id)) continue;
		if (isAccessToken(caller) && !tokenAllowsParent(caller, document.id)) continue;
		searchDocumentRecords(document.id, doc);
	}

	function searchCollectionRows(collectionId: string, collectionDoc: typeof doc): void {
		for (const row of listRecordsForParent(collectionDoc, collectionId)) {
			for (const value of Object.values(row.properties ?? {})) {
				const text = value.type === 'text' || value.type === 'select' ? value.value : '';
				if (text.toLowerCase().includes(needle)) {
					results.push({ recordId: row.id, snippet: snippetAround(text, needle) });
					break;
				}
			}
		}
	}

	// Catalog-listed Collections first — resolving each one's own shard from
	// the locator, since a fully-sharded Collection's own meta entry (not
	// just its rows) can live in a doc other than the default one, which
	// listCollections(doc) below could never see.
	const catalogCollectionIds = new Set<string>();
	for (const collectionMeta of listCatalogCollections(workspaceId)) {
		catalogCollectionIds.add(collectionMeta.id);
		if (isAccessToken(caller) && !tokenAllowsParent(caller, collectionMeta.id)) continue;
		const shard = resolveShardForParent(workspaceId, collectionMeta.id);
		const collectionDoc = shard
			? resolveWorkspaceContext({ workspaceId, shardId: shard.shardId }).doc
			: doc;
		searchCollectionRows(collectionMeta.id, collectionDoc);
	}

	// Then any Collection written directly to the Y.Doc, bypassing the
	// service layer entirely (and therefore uncataloged) — the catalog loop
	// above can't see these at all, so they're only findable via the default
	// doc directly, matching today's completeness for that case.
	for (const collection of listCollections(doc)) {
		if (catalogCollectionIds.has(collection.id)) continue;
		if (isAccessToken(caller) && !tokenAllowsParent(caller, collection.id)) continue;
		searchCollectionRows(collection.id, doc);
	}

	logAudit({
		actor,
		action: 'search_workspace',
		diff: { query, count: results.length }
	});
	return results;
}
