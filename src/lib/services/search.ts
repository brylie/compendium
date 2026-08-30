import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { listCollections, listDocuments, listRecordsForParent } from '$lib/data/records';
import { logAudit } from '$lib/server/audit';
import { listCatalogCollections, resolveShardForParent } from '$lib/server/catalog';
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

	for (const document of listDocuments(doc)) {
		if (isAccessToken(caller) && !tokenAllowsParent(caller, document.id)) continue;
		for (const record of listRecordsForParent(doc, document.id)) {
			const text = record.content ? richTextToMarkdown(doc, record.content) : '';
			if (text.toLowerCase().includes(needle)) {
				results.push({ recordId: record.id, snippet: snippetAround(text, needle) });
			}
		}
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
