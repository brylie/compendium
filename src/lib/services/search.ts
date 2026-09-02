import type * as Y from 'yjs';
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

interface SearchHit {
	recordId: string;
	snippet: string;
}

function snippetAround(text: string, needle: string): string {
	const index = text.toLowerCase().indexOf(needle);
	if (index === -1) return text.slice(0, 80);
	const start = Math.max(0, index - 30);
	const end = Math.min(text.length, index + needle.length + 30);
	return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function searchDocumentRecords(
	documentDoc: Y.Doc,
	documentId: string,
	needle: string,
	results: SearchHit[]
): void {
	for (const record of listRecordsForParent(documentDoc, documentId)) {
		const text = record.content ? richTextToMarkdown(documentDoc, record.content) : '';
		if (text.toLowerCase().includes(needle)) {
			results.push({ recordId: record.id, snippet: snippetAround(text, needle) });
		}
	}
}

// Catalog-listed Documents first — resolving each one's own shard from the
// locator (#120: each Document now has its own shard, same as Collections
// already did), since crdtListDocuments(doc) below could never see one that
// lives outside the default doc. Returns the catalog ids visited, so the
// uncataloged fallback below can skip them.
function searchCatalogDocuments(
	caller: CallerIdentity,
	doc: Y.Doc,
	workspaceId: string,
	spaceId: string | undefined,
	needle: string,
	results: SearchHit[]
): Set<string> {
	const catalogDocumentIds = new Set<string>();
	for (const documentMeta of listCatalogDocuments(workspaceId, spaceId)) {
		catalogDocumentIds.add(documentMeta.id);
		if (isAccessToken(caller) && !tokenAllowsParent(caller, documentMeta.id, documentMeta.spaceId))
			continue;
		const shard = resolveShardForParent(workspaceId, documentMeta.id);
		const documentDoc = shard
			? resolveWorkspaceContext({ workspaceId, shardId: shard.shardId }).doc
			: doc;
		searchDocumentRecords(documentDoc, documentMeta.id, needle, results);
	}
	return catalogDocumentIds;
}

// Any Document written directly to the Y.Doc, bypassing the service layer
// entirely (and therefore uncataloged) — only findable via the default doc
// directly, matching searchCatalogCollections's identical fallback below.
// Skipped entirely once a specific Space was requested — see
// searchWorkspace's own doc comment.
function searchUncatalogedDocuments(
	caller: CallerIdentity,
	doc: Y.Doc,
	spaceId: string | undefined,
	defaultSpaceId: string,
	catalogDocumentIds: Set<string>,
	needle: string,
	results: SearchHit[]
): void {
	if (spaceId !== undefined) return;
	for (const document of crdtListDocuments(doc)) {
		if (catalogDocumentIds.has(document.id)) continue;
		// Uncataloged content belongs to the default Space (no locator row to
		// resolve one from) — passed explicitly so a token whose only grant is
		// a default-Space grant still matches here, not just one with this
		// exact document id allowlisted.
		if (isAccessToken(caller) && !tokenAllowsParent(caller, document.id, defaultSpaceId)) continue;
		searchDocumentRecords(doc, document.id, needle, results);
	}
}

function searchCollectionRows(
	collectionDoc: Y.Doc,
	collectionId: string,
	needle: string,
	results: SearchHit[]
): void {
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

// Catalog-listed Collections first — resolving each one's own shard from the
// locator, since a fully-sharded Collection's own meta entry (not just its
// rows) can live in a doc other than the default one, which
// listCollections(doc) below could never see.
function searchCatalogCollections(
	caller: CallerIdentity,
	doc: Y.Doc,
	workspaceId: string,
	spaceId: string | undefined,
	needle: string,
	results: SearchHit[]
): Set<string> {
	const catalogCollectionIds = new Set<string>();
	for (const collectionMeta of listCatalogCollections(workspaceId, spaceId)) {
		catalogCollectionIds.add(collectionMeta.id);
		if (
			isAccessToken(caller) &&
			!tokenAllowsParent(caller, collectionMeta.id, collectionMeta.spaceId)
		)
			continue;
		const shard = resolveShardForParent(workspaceId, collectionMeta.id);
		const collectionDoc = shard
			? resolveWorkspaceContext({ workspaceId, shardId: shard.shardId }).doc
			: doc;
		searchCollectionRows(collectionDoc, collectionMeta.id, needle, results);
	}
	return catalogCollectionIds;
}

// Any Collection written directly to the Y.Doc, bypassing the service layer
// entirely (and therefore uncataloged) — the catalog loop above can't see
// these at all, so they're only findable via the default doc directly,
// matching today's completeness for that case. Skipped entirely once a
// specific Space was requested — see searchWorkspace's own doc comment.
function searchUncatalogedCollections(
	caller: CallerIdentity,
	doc: Y.Doc,
	spaceId: string | undefined,
	defaultSpaceId: string,
	catalogCollectionIds: Set<string>,
	needle: string,
	results: SearchHit[]
): void {
	if (spaceId !== undefined) return;
	for (const collection of listCollections(doc)) {
		if (catalogCollectionIds.has(collection.id)) continue;
		// Uncataloged content belongs to the default Space — see
		// searchUncatalogedDocuments' identical comment.
		if (isAccessToken(caller) && !tokenAllowsParent(caller, collection.id, defaultSpaceId))
			continue;
		searchCollectionRows(doc, collection.id, needle, results);
	}
}

/**
 * `spaceId` — see listDocuments' identical doc comment in documents.ts:
 * omitted, unchanged today's behavior (every Document/Collection in the
 * workspace, catalog plus uncataloged fallback); passed, strictly
 * catalog-scoped to that Space, skipping the uncataloged fallback entirely.
 */
export function searchWorkspace(
	caller: CallerIdentity,
	query: string,
	spaceId?: string
): SearchHit[] {
	const { doc, workspaceId, defaultSpaceId } = resolveWorkspaceContext();
	const actor = actorForCaller(caller);
	const needle = query.toLowerCase();
	const results: SearchHit[] = [];

	const catalogDocumentIds = searchCatalogDocuments(
		caller,
		doc,
		workspaceId,
		spaceId,
		needle,
		results
	);
	searchUncatalogedDocuments(
		caller,
		doc,
		spaceId,
		defaultSpaceId,
		catalogDocumentIds,
		needle,
		results
	);

	const catalogCollectionIds = searchCatalogCollections(
		caller,
		doc,
		workspaceId,
		spaceId,
		needle,
		results
	);
	searchUncatalogedCollections(
		caller,
		doc,
		spaceId,
		defaultSpaceId,
		catalogCollectionIds,
		needle,
		results
	);

	logAudit({
		actor,
		action: 'search_workspace',
		diff: { query, count: results.length }
	});
	return results;
}
