import * as Y from 'yjs';
import type { ParentKind, WorkspaceRecord } from './types';
import { blockCapabilitiesFor } from './block-capabilities';
import { applyRichTextToYText } from './richtext';
import { type TypedYMap, typedYMap } from './yjs-typed';
import {
	type CollectionYShape,
	type DocumentYShape,
	type RecordYShape,
	collectionsMap,
	documentsMap,
	recordsMap,
	setPropertyValue
} from './yjs-shapes';
import { applyOptionalBlockFields } from './view-config';
import { NotFoundError } from './errors';
import { getDocument } from './document-ops';
import { getCollection } from './collection-ops';
import { getRecord, isAuthoritativeChild } from './record-ops';

// ---------------------------------------------------------------------------
// Migration primitives (#114/#132) — verbatim structural copies of a
// Document or Collection's exact content into a different Y.Doc (a real
// per-record shard). Deliberately distinct from createDocument/createRecord:
// those compute a fresh order and stamp the calling actor/current time for a
// brand-new record, while a migration must reproduce every field of existing
// state exactly (id, order, content, and original actor/timestamp
// attribution) — nothing here is derived or recomputed.
// ---------------------------------------------------------------------------

/** Copies a Document and all of its records into `targetDoc` exactly as they exist in `sourceDoc`, recursing into records via copyRecordVerbatim. For sharding migrations, not for creating a fresh Document — see the section comment above. */
export function copyDocumentVerbatim(sourceDoc: Y.Doc, targetDoc: Y.Doc, id: string): void {
	const meta = getDocument(sourceDoc, id);
	if (!meta) throw new NotFoundError(`Document ${id} not found in source doc`);

	targetDoc.transact(() => {
		const ymeta = typedYMap<DocumentYShape>(new Y.Map<unknown>());
		ymeta.set('id', meta.id);
		ymeta.set('title', meta.title);
		if (meta.parentDocumentId) ymeta.set('parentDocumentId', meta.parentDocumentId);
		ymeta.set('order', meta.order);
		const recordIds = new Y.Array<string>();
		ymeta.set('recordIds', recordIds);
		documentsMap(targetDoc).set(meta.id, ymeta.raw);

		for (const recordId of meta.recordIds) {
			copyRecordVerbatim(sourceDoc, targetDoc, recordId, 'document');
			recordIds.push([recordId]);
		}
	});
}

/** Copies a Collection and all of its records into `targetDoc` exactly as they exist in `sourceDoc`, recursing into records via copyRecordVerbatim. For sharding migrations, not for creating a fresh Collection — see the section comment above. */
export function copyCollectionVerbatim(sourceDoc: Y.Doc, targetDoc: Y.Doc, id: string): void {
	const meta = getCollection(sourceDoc, id);
	if (!meta) throw new NotFoundError(`Collection ${id} not found in source doc`);

	targetDoc.transact(() => {
		const ymeta = typedYMap<CollectionYShape>(new Y.Map<unknown>());
		ymeta.set('title', meta.title);
		ymeta.set('schema', meta.schema);
		const recordIds = new Y.Array<string>();
		ymeta.set('recordIds', recordIds);
		if (meta.primaryFieldKey) ymeta.set('primaryFieldKey', meta.primaryFieldKey);
		collectionsMap(targetDoc).set(meta.id, ymeta.raw);

		for (const recordId of meta.recordIds) {
			copyRecordVerbatim(sourceDoc, targetDoc, recordId, 'collection');
			recordIds.push([recordId]);
		}
	});
}

/**
 * Copies one record (block or row) into `targetDoc` with every field
 * preserved exactly, recursing into a container block's (columns/column,
 * issue #148) own children the same way copyDocumentVerbatim/
 * copyCollectionVerbatim recurse into a Document/Collection's top-level
 * records — a container's children live only in its own `recordIds` array,
 * never in the owning Document's, so without this recursion a shard
 * migration would silently drop every block nested inside a columns block.
 * Does not touch the *parent's* recordIds array — the top-level caller
 * (copyDocumentVerbatim/copyCollectionVerbatim) pushes the id themselves,
 * once, in the legacy order already recorded on the source meta; a
 * recursive call here owns its own container's recordIds array instead,
 * exactly mirroring that same split one level down.
 */
// Populates a copied record's block-vs-row fields — split out of
// copyRecordVerbatim purely to keep its own cognitive complexity down.
function applyCopiedRecordFields(
	yrecord: TypedYMap<RecordYShape>,
	record: WorkspaceRecord,
	kind: ParentKind
): void {
	if (kind === 'document' || kind === 'record') {
		const blockType = record.blockType ?? 'paragraph';
		yrecord.set('blockType', blockType);
		// A container (BLOCK_CAPABILITIES[...].isContainer, issue #229) has no
		// content Y.Text at all, matching how createRecord builds one fresh —
		// not a present-but-empty one, which would round-trip differently
		// through readRecord (an empty Y.Text is still truthy, so it wouldn't
		// read back as `undefined`).
		if (!blockCapabilitiesFor(blockType).isContainer) {
			const ytext = new Y.Text();
			if (record.content) applyRichTextToYText(ytext, record.content);
			yrecord.set('content', ytext);
		}
		applyOptionalBlockFields(yrecord, record);
	} else {
		yrecord.set('isCollectionRow', true);
		for (const [key, value] of Object.entries(record.properties ?? {})) {
			setPropertyValue(yrecord, key, value);
		}
	}
}

// Recursively copies a container's own children, skipping a stale leftover
// entry from a concurrent cross-container moveRecordToParent (issue #148)
// whose own `parentId` now authoritatively points elsewhere — see
// record-ops.ts#isAuthoritativeChild's doc comment. Copying it here too
// would duplicate that record under two parents in the migrated doc (once
// under its real, live parent when *that* parent is copied, and again here
// under this stale reference). Split out of copyRecordVerbatim purely to
// keep its own cognitive complexity down.
function copyAuthoritativeChildren(
	sourceDoc: Y.Doc,
	targetDoc: Y.Doc,
	id: string,
	childIds: string[],
	childRecordIds: Y.Array<string>
): void {
	for (const childId of childIds) {
		if (!isAuthoritativeChild(sourceDoc, id, childId)) continue;
		copyRecordVerbatim(sourceDoc, targetDoc, childId, 'record');
		childRecordIds.push([childId]);
	}
}

function copyRecordVerbatim(
	sourceDoc: Y.Doc,
	targetDoc: Y.Doc,
	id: string,
	kind: ParentKind
): void {
	const record = getRecord(sourceDoc, id);
	if (!record) throw new NotFoundError(`Record ${id} not found in source doc`);

	const yrecord: TypedYMap<RecordYShape> = typedYMap<RecordYShape>(new Y.Map<unknown>());
	yrecord.set('id', record.id);
	yrecord.set('parentId', record.parentId);
	yrecord.set('order', record.order);
	yrecord.set('createdBy', record.createdBy);
	yrecord.set('createdAt', record.createdAt);
	yrecord.set('lastEditedBy', record.lastEditedBy);
	yrecord.set('lastEditedAt', record.lastEditedAt);

	applyCopiedRecordFields(yrecord, record, kind);

	if (record.childRecordIds) {
		const childRecordIds = new Y.Array<string>();
		yrecord.set('recordIds', childRecordIds);
		recordsMap(targetDoc).set(id, yrecord.raw);
		copyAuthoritativeChildren(sourceDoc, targetDoc, id, record.childRecordIds, childRecordIds);
		return;
	}

	recordsMap(targetDoc).set(id, yrecord.raw);
}
