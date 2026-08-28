import type * as Y from 'yjs';
import {
	getCollection,
	getDocument,
	getRecord,
	listDocuments,
	listRecordsForParent
} from './records';
import { plainText } from './richtext';

// The one canonical internal-link representation, shared by `page_link`
// blocks (target on the block record's `referencedRecordId`) and inline
// `[[wiki links]]` (target on a `link` mark using this `record:` scheme —
// see markdown-transcoding.md). Both persist a target ID and nothing else;
// the display title is always re-derived here, live, from the current
// Documents/Collections index — never cached alongside the link itself.
// That's what makes rename/move a non-event for an existing link, and a
// delete something this module can report explicitly rather than silently.
export const RECORD_LINK_SCHEME = 'record:';

export interface InternalLinkTarget {
	id: string;
	kind: 'document' | 'collection';
	title: string;
}

/**
 * Resolves an internal-link target ID to its current title. Returns
 * `undefined` when the ID no longer names a Document or Collection — the
 * target was deleted since the link was created. Callers render that as an
 * explicit "broken link" state rather than falling back to a stale title.
 */
export function resolveInternalLinkTarget(doc: Y.Doc, id: string): InternalLinkTarget | undefined {
	const document = getDocument(doc, id);
	if (document) return { id, kind: 'document', title: document.title };
	const collection = getCollection(doc, id);
	if (collection) return { id, kind: 'collection', title: collection.title };
	return undefined;
}

export interface OutgoingLink {
	sourceRecordId: string;
	targetId: string;
	/** `undefined` means the target no longer exists — a broken link. */
	target: InternalLinkTarget | undefined;
}

/**
 * A reference to a Document discovered by scanning the shared, ID-backed
 * outgoing-link representation. `context` is the current text of the exact
 * referring block, so it changes with edits instead of becoming stale beside
 * the backlink.
 */
export interface Backlink {
	sourceDocumentId: string;
	sourceDocumentTitle: string;
	sourceRecordId: string;
	context: string;
}

interface BacklinkIndex {
	byTargetId: Map<string, IndexedBacklink[]>;
	bySourceRecordId: Map<string, IndexedBacklink[]>;
}

interface IndexedBacklink extends Backlink {
	targetId: string;
}

const backlinkIndexes = new WeakMap<Y.Doc, BacklinkIndex>();

export function isLinkBroken(link: OutgoingLink): boolean {
	return link.target === undefined;
}

/**
 * Every internal link a Document's own records point outward to — both
 * `page_link` blocks and inline wiki-link marks in block content. One
 * ID-backed representation, one place that walks it: the basis for both
 * the current outgoing-link rendering and (per #21) a future incoming-link
 * (backlink) index built by scanning this across every Document.
 */
export function listOutgoingLinks(doc: Y.Doc, documentId: string): OutgoingLink[] {
	const links: OutgoingLink[] = [];
	for (const record of listRecordsForParent(doc, documentId)) {
		for (const targetId of targetIdsForRecord(record)) {
			links.push({
				sourceRecordId: record.id,
				targetId,
				target: resolveInternalLinkTarget(doc, targetId)
			});
		}
	}
	return links;
}

/** Extract the stable internal-link target IDs carried by one workspace record. */
function targetIdsForRecord(record: ReturnType<typeof getRecord>): string[] {
	if (!record) return [];
	if (record.blockType === 'page_link' && record.referencedRecordId) {
		return [record.referencedRecordId];
	}
	return (record.content?.runs ?? [])
		.map((run) => run.marks.link)
		.filter((href): href is string => href?.startsWith(RECORD_LINK_SCHEME) ?? false)
		.map((href) => href.slice(RECORD_LINK_SCHEME.length));
}

/** Remove every prior backlink contribution made by one source record. */
function removeRecordFromIndex(index: BacklinkIndex, sourceRecordId: string): void {
	const oldBacklinks = index.bySourceRecordId.get(sourceRecordId) ?? [];
	for (const backlink of oldBacklinks) {
		const targetBacklinks = index.byTargetId.get(backlink.targetId);
		if (!targetBacklinks) continue;
		const remaining = targetBacklinks.filter((entry) => entry !== backlink);
		if (remaining.length === 0) index.byTargetId.delete(backlink.targetId);
		else index.byTargetId.set(backlink.targetId, remaining);
	}
	index.bySourceRecordId.delete(sourceRecordId);
}

/** Recompute one changed record's entries without scanning other Documents. */
function indexRecord(doc: Y.Doc, index: BacklinkIndex, sourceRecordId: string): void {
	removeRecordFromIndex(index, sourceRecordId);
	const sourceRecord = getRecord(doc, sourceRecordId);
	if (!sourceRecord) return;
	const sourceDocument = getDocument(doc, sourceRecord.parentId);
	if (!sourceDocument) return;

	const context =
		(sourceRecord.content ? plainText(sourceRecord.content).trim() : '') ||
		(sourceRecord.blockType === 'page_link' ? 'Page link' : 'Untitled block');
	const backlinks = targetIdsForRecord(sourceRecord).map((targetId) => ({
		targetId,
		sourceDocumentId: sourceDocument.id,
		sourceDocumentTitle: sourceDocument.title,
		sourceRecordId,
		context
	}));

	if (backlinks.length === 0) return;
	index.bySourceRecordId.set(sourceRecordId, backlinks);
	for (const backlink of backlinks) {
		const targetBacklinks = index.byTargetId.get(backlink.targetId) ?? [];
		targetBacklinks.push(backlink);
		index.byTargetId.set(backlink.targetId, targetBacklinks);
	}
}

/** Refresh only the backlinks whose displayed source metadata changed. */
function indexDocumentSources(doc: Y.Doc, index: BacklinkIndex, sourceDocumentId: string): void {
	const sourceRecordIds = [...index.bySourceRecordId]
		.filter(([, backlinks]) =>
			backlinks.some((backlink) => backlink.sourceDocumentId === sourceDocumentId)
		)
		.map(([sourceRecordId]) => sourceRecordId);
	for (const sourceRecordId of sourceRecordIds) {
		indexRecord(doc, index, sourceRecordId);
	}
}

/** Collect direct record or Document IDs affected by a deep Yjs observer event batch. */
function eventIds(
	events: Array<{
		path: Array<string | number>;
		target: unknown;
		changes: { keys: Map<string, unknown> };
	}>,
	root: unknown
): Set<string> {
	const ids = new Set<string>();
	for (const event of events) {
		const firstPathSegment = event.path[0];
		if (typeof firstPathSegment === 'string') ids.add(firstPathSegment);
		if (event.target === root && event.changes.keys) {
			for (const id of event.changes.keys.keys()) ids.add(id);
		}
	}
	return ids;
}

/** Lazily build and incrementally maintain one reverse-link index per Y.Doc. */
function getBacklinkIndex(doc: Y.Doc): BacklinkIndex {
	const existing = backlinkIndexes.get(doc);
	if (existing) return existing;

	const index: BacklinkIndex = { byTargetId: new Map(), bySourceRecordId: new Map() };
	const records = doc.getMap<Y.AbstractType<unknown>>('records');
	const documents = doc.getMap<Y.AbstractType<unknown>>('documents');
	for (const sourceDocument of listDocuments(doc)) {
		for (const sourceRecord of listRecordsForParent(doc, sourceDocument.id)) {
			indexRecord(doc, index, sourceRecord.id);
		}
	}

	// Observe only the structures that can change a backlink. A text/target
	// edit updates one source record; a source-document metadata change updates
	// only that Document's existing backlinks. Unrelated workspace mutations do
	// not rescan the graph.
	records.observeDeep((events) => {
		for (const sourceRecordId of eventIds(events, records)) {
			indexRecord(doc, index, sourceRecordId);
		}
	});
	documents.observeDeep((events) => {
		for (const sourceDocumentId of eventIds(events, documents)) {
			indexDocumentSources(doc, index, sourceDocumentId);
		}
	});

	backlinkIndexes.set(doc, index);
	return index;
}

/**
 * Every Document that points at `targetId`, via either a page_link block or
 * an inline `record:` wiki-link. The first lookup builds a reverse index from
 * `listOutgoingLinks`; subsequent Yjs edits refresh only the affected source
 * record or Document metadata. Renames, moves, duplicate titles, and source
 * deletion therefore remain correct without rescanning the workspace.
 */
export function listIncomingLinks(doc: Y.Doc, targetId: string): Backlink[] {
	return (getBacklinkIndex(doc).byTargetId.get(targetId) ?? []).map((backlink) => ({
		sourceDocumentId: backlink.sourceDocumentId,
		sourceDocumentTitle: backlink.sourceDocumentTitle,
		sourceRecordId: backlink.sourceRecordId,
		context: backlink.context
	}));
}
