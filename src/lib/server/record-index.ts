import { sql } from 'drizzle-orm';
import type * as Y from 'yjs';
import { getDb } from './store.js';
import {
	getRecord,
	listAllRecordIds,
	parentKindOf,
	resolveOwningParentId
} from '../data/record-ops.js';
import type { PropertyValue, RichText, WorkspaceRecord } from '../data/types.js';

// Deliberately not `$lib/data/markdown-transcode`'s richTextToMarkdown: this
// module is reachable from workspace-store.ts, which vite.config.ts imports
// at its own top level (for preview mode) — a context where the `$lib`
// alias isn't registered yet (see the rest of src/lib/server/*.ts, which
// only ever imports the data layer via relative paths for exactly this
// reason). richTextToMarkdown also performs a server-backed lookup to resolve
// a cross-shard wiki-link's *display title*, which the plain-text search index
// has no use for anyway — the raw run text below is both
// simpler and a better search signal (no Markdown escaping/`[[brackets]]`
// noise in what an agent's query has to match).
function plainTextFromRichText(richText: RichText): string {
	return richText.runs.map((run) => run.text).join('');
}

// persistence.md §2's `record_index` read model: a one-directional,
// disposable FTS5 projection of the Y.Doc, kept in sync by
// record-index-observer.ts and rebuilt wholesale on every shard load (see
// rebuildRecordIndexForShard) — never a parallel write path. Backs
// search.ts#searchWorkspace's full-text matching. `query_collection`'s
// `filter` deliberately does NOT read from here: a Collection's own records
// are already cheaply available from the single shard `queryCollection`
// resolves anyway, so filtering them in-memory with the same
// `$lib/data/views#applyFilters` the UI's Table/Board/Calendar views use
// gives real UI/MCP parity without adding a SQLite dependency to that path
// — see collections.ts#queryCollection and docs/specifications/
// collection-views.md §8 for the resolved architecture decision.

const isTextOrSelect = (
	value: PropertyValue
): value is Extract<PropertyValue, { type: 'text' | 'select' }> =>
	value.type === 'text' || value.type === 'select';

/**
 * The same text a record contributes to search today (search.ts's
 * pre-existing searchDocumentRecords/searchCollectionRows): a block's raw
 * text content, or a Collection row's text/select property values — never a
 * number/checkbox/date/relation value, which never was searchable text.
 */
function plainTextForRecord(record: WorkspaceRecord): string {
	const parts: string[] = [];
	if (record.content) parts.push(plainTextFromRichText(record.content));
	if (record.properties) {
		for (const value of Object.values(record.properties)) {
			if (isTextOrSelect(value)) parts.push(value.value);
		}
	}
	return parts.join('\n');
}

/** Removes any existing row for `recordId` — FTS5 has no upsert/unique constraint of its own to lean on. */
export function deleteRecordIndexEntry(recordId: string): void {
	getDb().run(sql`DELETE FROM record_index WHERE record_id = ${recordId}`);
}

/**
 * Recomputes and writes `recordId`'s row from its current authoritative
 * `Y.Doc` state — called on every create/update reaching that record (see
 * record-index-observer.ts). Clears any stale row instead of writing one
 * when the record no longer exists, or its parent chain (`resolveOwningParentId`)
 * no longer resolves to a real Document/Collection (an inconsistent/orphaned
 * record isn't worth indexing).
 */
export function upsertRecordIndexEntry(
	workspaceId: string,
	shardId: string,
	doc: Y.Doc,
	recordId: string
): void {
	const record = getRecord(doc, recordId);
	if (!record) {
		deleteRecordIndexEntry(recordId);
		return;
	}
	const parentId = resolveOwningParentId(doc, record.parentId);
	const parentType = parentKindOf(doc, parentId);
	if (parentType !== 'document' && parentType !== 'collection') {
		deleteRecordIndexEntry(recordId);
		return;
	}

	const plainTextContent = plainTextForRecord(record);
	const propertiesJson = JSON.stringify(record.properties ?? {});

	getDb().transaction((tx) => {
		tx.run(sql`DELETE FROM record_index WHERE record_id = ${recordId}`);
		tx.run(sql`
			INSERT INTO record_index
				(record_id, workspace_id, shard_id, parent_id, parent_type, plain_text_content, properties_json)
			VALUES
				(${recordId}, ${workspaceId}, ${shardId}, ${parentId}, ${parentType}, ${plainTextContent}, ${propertiesJson})
		`);
	});
}

/**
 * Wipes and rebuilds every record_index row for one shard from its
 * just-loaded `Y.Doc` — the "rebuildable by replaying the Y.Doc's current
 * state" contract persistence.md §2 requires. Run once per shard context
 * load (workspace-store.ts's createContext(), right before
 * attachRecordIndexObserver takes over keeping it live) so a restarted
 * process, or an idle-unloaded shard reloading (#122), never serves a stale
 * or missing projection for content that's actually still there.
 */
export function rebuildRecordIndexForShard(workspaceId: string, shardId: string, doc: Y.Doc): void {
	getDb().run(
		sql`DELETE FROM record_index WHERE workspace_id = ${workspaceId} AND shard_id = ${shardId}`
	);
	for (const recordId of listAllRecordIds(doc)) {
		upsertRecordIndexEntry(workspaceId, shardId, doc, recordId);
	}
}

export interface RecordIndexSearchHit {
	recordId: string;
	parentId: string;
	plainTextContent: string;
}

interface RecordIndexRow {
	record_id: string;
	parent_id: string;
	plain_text_content: string;
}

/** Quotes `text` as a single FTS5 phrase, so arbitrary caller input (punctuation, reserved words like AND/OR/NOT, unbalanced quotes) is never interpreted as FTS5 query syntax — only doubled internal quotes, per FTS5's own quoting convention. */
function fts5Phrase(text: string): string {
	return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Full-text search over every indexed record in `workspaceId` matching
 * `needle` — the SQLite FTS5 query search.ts#searchWorkspace backs its
 * full-text matching with (persistence.md §2), replacing the prior
 * in-memory substring scan across every shard's own already-loaded content
 * on every call. Knows nothing about permissions or Spaces — the caller
 * (search.ts) already resolves the allowed/Space-scoped parent id set via
 * the same catalog fan-out it always has and filters this function's
 * results against it, exactly as it filtered the old scan's results.
 * An empty/blank `needle` matches every row, matching the prior scan's own
 * `"".includes(x)` behavior instead of raising an FTS5 empty-phrase syntax
 * error.
 */
export function searchRecordIndex(workspaceId: string, needle: string): RecordIndexSearchHit[] {
	const trimmed = needle.trim();
	const rows = trimmed
		? getDb().all<RecordIndexRow>(sql`
				SELECT record_id, parent_id, plain_text_content
				FROM record_index
				WHERE workspace_id = ${workspaceId} AND record_index MATCH ${fts5Phrase(trimmed)}
			`)
		: getDb().all<RecordIndexRow>(sql`
				SELECT record_id, parent_id, plain_text_content
				FROM record_index
				WHERE workspace_id = ${workspaceId}
			`);

	return rows.map((row) => ({
		recordId: row.record_id,
		parentId: row.parent_id,
		plainTextContent: row.plain_text_content
	}));
}
