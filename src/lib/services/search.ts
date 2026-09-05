import type * as Y from 'yjs';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import {
	listCollections as crdtListCollections,
	listDocuments as crdtListDocuments,
	listRecordsForParent
} from '$lib/data/records';
import { logAudit } from '$lib/server/audit';
import { listCatalogCollections, listCatalogDocuments } from '$lib/server/catalog';
import { tokenAllowsParent } from '$lib/server/token-store';
import { richTextToMarkdown } from '$lib/mcp/markdown-transcode';
import { fanOutCatalogedAndUncataloged } from '$lib/server/workspace-repository';
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

/**
 * `spaceId` — see listDocuments' identical doc comment in documents.ts:
 * omitted, unchanged today's behavior (every Document/Collection in the
 * workspace, catalog plus uncataloged fallback); passed, strictly
 * catalog-scoped to that Space, skipping the uncataloged fallback entirely.
 *
 * The catalog-plus-fallback fan-out (including each catalog-listed item's
 * own-shard resolution, needed here to actually scan its content) is owned
 * by `$lib/server/workspace-repository` (#191) — shared with
 * `documents.ts#listDocuments` and `collections.ts#listCollections`. Search
 * previously re-implemented this fan-out a second time, independently, and
 * had drifted from the other two: its uncataloged-fallback guard skipped on
 * *any* explicit spaceId rather than only a non-default one, so
 * `searchWorkspace(caller, query, defaultSpaceId)` silently omitted
 * legacy/uncataloged content that `listDocuments`/`listCollections` would
 * include for the same input. Routing through the shared fan-out fixes that
 * drift by construction.
 */
export function searchWorkspace(
	caller: CallerIdentity,
	query: string,
	spaceId?: string
): SearchHit[] {
	const { doc: defaultDoc, workspaceId, defaultSpaceId } = resolveWorkspaceContext();
	const actor = actorForCaller(caller);
	const needle = query.toLowerCase();
	const results: SearchHit[] = [];
	const allowed = (id: string, itemSpaceId?: string) =>
		!isAccessToken(caller) || tokenAllowsParent(caller, id, itemSpaceId);

	for (const { meta, doc } of fanOutCatalogedAndUncataloged({
		workspaceId,
		spaceId,
		defaultSpaceId,
		defaultDoc,
		listCatalog: listCatalogDocuments,
		listUncataloged: crdtListDocuments,
		getId: (m) => m.id,
		getSpaceId: (m) => m.spaceId,
		allowed,
		resolveShardDoc: true
	})) {
		searchDocumentRecords(doc, meta.id, needle, results);
	}

	for (const { meta, doc } of fanOutCatalogedAndUncataloged({
		workspaceId,
		spaceId,
		defaultSpaceId,
		defaultDoc,
		listCatalog: listCatalogCollections,
		listUncataloged: crdtListCollections,
		getId: (m) => m.id,
		getSpaceId: (m) => m.spaceId,
		allowed,
		resolveShardDoc: true
	})) {
		searchCollectionRows(doc, meta.id, needle, results);
	}

	logAudit({
		actor,
		action: 'search_workspace',
		diff: { query, count: results.length }
	});
	return results;
}
