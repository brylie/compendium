import * as Y from 'yjs';
import type { ParentKind } from './types';
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
import { getRecord } from './record-ops';

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
 * preserved exactly. Does not touch the parent's recordIds array — callers
 * (copyDocumentVerbatim/copyCollectionVerbatim) push the id themselves, once,
 * in the legacy order already recorded on the source meta.
 */
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

	if (kind === 'document') {
		yrecord.set('blockType', record.blockType ?? 'paragraph');
		const ytext = new Y.Text();
		if (record.content) applyRichTextToYText(ytext, record.content);
		yrecord.set('content', ytext);
		applyOptionalBlockFields(yrecord, record);
	} else {
		yrecord.set('isCollectionRow', true);
		for (const [key, value] of Object.entries(record.properties ?? {})) {
			setPropertyValue(yrecord, key, value);
		}
	}

	recordsMap(targetDoc).set(id, yrecord.raw);
}
