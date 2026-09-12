import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { listDocuments as crdtListDocuments } from '$lib/data/document-ops';
import { listCollections as crdtListCollections } from '$lib/data/collection-ops';
import { logAudit } from '$lib/server/audit';
import { listCatalogCollections, listCatalogDocuments } from '$lib/server/catalog';
import { tokenAllowsParent } from '$lib/server/token-store';
import { fanOutCatalogedAndUncataloged } from '$lib/server/workspace-repository';
import { searchRecordIndex } from '$lib/server/record-index';
import { actorForCaller, isAccessToken, type CallerIdentity } from './permissions';

interface SearchHit {
	recordId: string;
	snippet: string;
}

function snippetAround(text: string, needle: string): string {
	const index = text.toLowerCase().indexOf(needle.toLowerCase());
	if (index === -1) return text.slice(0, 80);
	const start = Math.max(0, index - 30);
	const end = Math.min(text.length, index + needle.length + 30);
	return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/**
 * `spaceId` — see listDocuments' identical doc comment in documents.ts:
 * omitted, unchanged today's behavior (every Document/Collection in the
 * workspace, catalog plus uncataloged fallback); passed, strictly
 * catalog-scoped to that Space, skipping the uncataloged fallback entirely.
 *
 * The catalog-plus-fallback fan-out (owned by `$lib/server/workspace-repository`,
 * #191, shared with `documents.ts#listDocuments` and
 * `collections.ts#listCollections`) still resolves and permission/Space-filters
 * every Document/Collection exactly as before — that's what decides *which*
 * ids are allowed, and resolving each one's own shard (`resolveShardDoc: true`)
 * is also what keeps its record_index rows fresh via
 * workspace-store.ts's per-shard rebuild-on-load (persistence.md §2). The
 * actual content match against `query` now reads from that SQLite FTS5
 * projection (`$lib/server/record-index#searchRecordIndex`) instead of
 * re-decoding every record's Markdown/property text and substring-scanning
 * it in JS on every call — the same one-shot-query read model
 * persistence.md §2 specs, replacing this function's own prior from-scratch
 * scan.
 */
export function searchWorkspace(
	caller: CallerIdentity,
	query: string,
	spaceId?: string
): SearchHit[] {
	const { doc: defaultDoc, workspaceId, defaultSpaceId } = resolveWorkspaceContext();
	const actor = actorForCaller(caller);
	const allowed = (id: string, itemSpaceId?: string) =>
		!isAccessToken(caller) || tokenAllowsParent(caller, id, itemSpaceId);
	const allowedParentIds = new Set<string>();

	for (const { meta } of fanOutCatalogedAndUncataloged({
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
		allowedParentIds.add(meta.id);
	}

	for (const { meta } of fanOutCatalogedAndUncataloged({
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
		allowedParentIds.add(meta.id);
	}

	const results: SearchHit[] = searchRecordIndex(workspaceId, query)
		.filter((hit) => allowedParentIds.has(hit.parentId))
		.map((hit) => ({
			recordId: hit.recordId,
			snippet: snippetAround(hit.plainTextContent, query)
		}));

	logAudit({
		actor,
		action: 'search_workspace',
		diff: { query, count: results.length }
	});
	return results;
}
