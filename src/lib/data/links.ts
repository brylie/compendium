import type * as Y from 'yjs';
import { getCollection, getDocument, listRecordsForParent } from './records';

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
		if (record.blockType === 'page_link' && record.referencedRecordId) {
			links.push({
				sourceRecordId: record.id,
				targetId: record.referencedRecordId,
				target: resolveInternalLinkTarget(doc, record.referencedRecordId)
			});
			continue;
		}
		for (const run of record.content?.runs ?? []) {
			if (run.marks.link?.startsWith(RECORD_LINK_SCHEME)) {
				const targetId = run.marks.link.slice(RECORD_LINK_SCHEME.length);
				links.push({
					sourceRecordId: record.id,
					targetId,
					target: resolveInternalLinkTarget(doc, targetId)
				});
			}
		}
	}
	return links;
}
