import * as Y from 'yjs';
import { generateKeyBetween } from 'fractional-indexing';
import { nanoid } from 'nanoid';
import type {
	ActorId,
	BlockType,
	CollectionMeta,
	DocumentMeta,
	ParentKind,
	PropertyDefinition,
	PropertyValue,
	RichText,
	WorkspaceRecord
} from './types';
import { applyRichTextToYText, yTextToRichText } from './richtext';

const DOCUMENTS = 'documents';
const COLLECTIONS = 'collections';
const RECORDS = 'records';

// Properties are stored as individual `prop:<key>` entries on the record's
// Y.Map, rather than one JSON blob under a single key, so two humans editing
// different properties of the same row concurrently each merge (Y.Map's
// per-key LWW) instead of one clobbering the other's unrelated edit.
const PROP_PREFIX = 'prop:';

function documentsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
	return doc.getMap(DOCUMENTS);
}
function collectionsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
	return doc.getMap(COLLECTIONS);
}
function recordsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
	return doc.getMap(RECORDS);
}

export class NotFoundError extends Error {}
export class PermissionError extends Error {}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export function listDocuments(doc: Y.Doc): DocumentMeta[] {
	const out: DocumentMeta[] = [];
	documentsMap(doc).forEach((ymeta, id) => {
		out.push(readDocumentMeta(id, ymeta as Y.Map<unknown>));
	});
	return out;
}

export function getDocument(doc: Y.Doc, id: string): DocumentMeta | undefined {
	const ymeta = documentsMap(doc).get(id) as Y.Map<unknown> | undefined;
	return ymeta ? readDocumentMeta(id, ymeta) : undefined;
}

function readDocumentMeta(id: string, ymeta: Y.Map<unknown>): DocumentMeta {
	const recordIds = ymeta.get('recordIds') as Y.Array<string>;
	return {
		id,
		title: ymeta.get('title') as string,
		recordIds: recordIds.toArray()
	};
}

export function createDocument(doc: Y.Doc, input: { id?: string; title: string }): DocumentMeta {
	const id = input.id ?? nanoid();
	doc.transact(() => {
		const ymeta = new Y.Map<unknown>();
		ymeta.set('title', input.title);
		ymeta.set('recordIds', new Y.Array<string>());
		documentsMap(doc).set(id, ymeta);
	});
	return { id, title: input.title, recordIds: [] };
}

export function updateDocumentTitle(doc: Y.Doc, id: string, title: string): void {
	const ymeta = documentsMap(doc).get(id) as Y.Map<unknown> | undefined;
	if (!ymeta) throw new NotFoundError(`Document ${id} not found`);
	ymeta.set('title', title);
}

export function updateCollectionTitle(doc: Y.Doc, id: string, title: string): void {
	const ymeta = collectionsMap(doc).get(id) as Y.Map<unknown> | undefined;
	if (!ymeta) throw new NotFoundError(`Collection ${id} not found`);
	ymeta.set('title', title);
}

export function deleteDocument(doc: Y.Doc, id: string): void {
	doc.transact(() => {
		const meta = getDocument(doc, id);
		if (!meta) return;
		for (const recordId of meta.recordIds) {
			recordsMap(doc).delete(recordId);
		}
		documentsMap(doc).delete(id);
	});
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export function listCollections(doc: Y.Doc): CollectionMeta[] {
	const out: CollectionMeta[] = [];
	collectionsMap(doc).forEach((ymeta, id) => {
		out.push(readCollectionMeta(id, ymeta as Y.Map<unknown>));
	});
	return out;
}

export function getCollection(doc: Y.Doc, id: string): CollectionMeta | undefined {
	const ymeta = collectionsMap(doc).get(id) as Y.Map<unknown> | undefined;
	return ymeta ? readCollectionMeta(id, ymeta) : undefined;
}

function readCollectionMeta(id: string, ymeta: Y.Map<unknown>): CollectionMeta {
	const recordIds = ymeta.get('recordIds') as Y.Array<string>;
	return {
		id,
		title: ymeta.get('title') as string,
		schema: (ymeta.get('schema') as PropertyDefinition[]) ?? [],
		recordIds: recordIds.toArray()
	};
}

export function createCollection(
	doc: Y.Doc,
	input: { id?: string; title: string; schema: PropertyDefinition[] }
): CollectionMeta {
	const id = input.id ?? nanoid();
	doc.transact(() => {
		const ymeta = new Y.Map<unknown>();
		ymeta.set('title', input.title);
		ymeta.set('schema', input.schema);
		ymeta.set('recordIds', new Y.Array<string>());
		collectionsMap(doc).set(id, ymeta);
	});
	return { id, title: input.title, schema: input.schema, recordIds: [] };
}

export function updateCollectionSchema(doc: Y.Doc, id: string, schema: PropertyDefinition[]): void {
	const ymeta = collectionsMap(doc).get(id) as Y.Map<unknown> | undefined;
	if (!ymeta) throw new NotFoundError(`Collection ${id} not found`);
	ymeta.set('schema', schema);
}

export function deleteCollection(doc: Y.Doc, id: string): void {
	doc.transact(() => {
		const meta = getCollection(doc, id);
		if (!meta) return;
		for (const recordId of meta.recordIds) {
			recordsMap(doc).delete(recordId);
		}
		collectionsMap(doc).delete(id);
	});
}

// ---------------------------------------------------------------------------
// Records (blocks and rows — one addressing scheme)
// ---------------------------------------------------------------------------

function parentKindOf(doc: Y.Doc, parentId: string): ParentKind | undefined {
	if (documentsMap(doc).has(parentId)) return 'document';
	if (collectionsMap(doc).has(parentId)) return 'collection';
	return undefined;
}

function parentRecordIds(doc: Y.Doc, parentId: string, kind: ParentKind): Y.Array<string> {
	const map = kind === 'document' ? documentsMap(doc) : collectionsMap(doc);
	const ymeta = map.get(parentId) as Y.Map<unknown>;
	return ymeta.get('recordIds') as Y.Array<string>;
}

/**
 * Direct access to a block-record's Y.Text, for the UI's live keystroke
 * binding (§8) — MCP writes go through updateRecordContent's whole-block
 * replace instead, since they arrive as one finished write, not keystrokes.
 */
export function getRecordYText(doc: Y.Doc, id: string): Y.Text | undefined {
	const yrecord = recordsMap(doc).get(id) as Y.Map<unknown> | undefined;
	return yrecord?.get('content') as Y.Text | undefined;
}

export function touchRecordEditor(doc: Y.Doc, id: string, actor: ActorId): void {
	const yrecord = recordsMap(doc).get(id) as Y.Map<unknown> | undefined;
	if (!yrecord) return;
	yrecord.set('lastEditedBy', actor);
	yrecord.set('lastEditedAt', Date.now());
}

export function getRecord(doc: Y.Doc, id: string): WorkspaceRecord | undefined {
	const yrecord = recordsMap(doc).get(id) as Y.Map<unknown> | undefined;
	return yrecord ? readRecord(yrecord) : undefined;
}

function readRecord(yrecord: Y.Map<unknown>): WorkspaceRecord {
	const content = yrecord.get('content') as Y.Text | undefined;
	const properties: Record<string, PropertyValue> = {};
	yrecord.forEach((value, key) => {
		if (key.startsWith(PROP_PREFIX)) {
			properties[key.slice(PROP_PREFIX.length)] = value as PropertyValue;
		}
	});
	const hasProps = Object.keys(properties).length > 0 || yrecord.get('isCollectionRow');

	return {
		id: yrecord.get('id') as string,
		parentId: yrecord.get('parentId') as string,
		order: yrecord.get('order') as string,
		blockType: yrecord.get('blockType') as BlockType | undefined,
		content: content ? yTextToRichText(content) : undefined,
		properties: hasProps ? properties : undefined,
		createdBy: yrecord.get('createdBy') as ActorId,
		createdAt: yrecord.get('createdAt') as number,
		lastEditedBy: yrecord.get('lastEditedBy') as ActorId,
		lastEditedAt: yrecord.get('lastEditedAt') as number
	};
}

export interface CreateRecordInput {
	id?: string;
	parentId: string;
	afterRecordId?: string;
	blockType?: BlockType; // set when parent is a Document
	properties?: Record<string, PropertyValue>; // set when parent is a Collection
}

export function createRecord(
	doc: Y.Doc,
	input: CreateRecordInput,
	actor: ActorId
): WorkspaceRecord {
	const kind = parentKindOf(doc, input.parentId);
	if (!kind) throw new NotFoundError(`Parent ${input.parentId} not found`);

	const id = input.id ?? nanoid();
	const now = Date.now();

	return doc.transact(() => {
		const siblingIds = parentRecordIds(doc, input.parentId, kind);
		const insertAt = input.afterRecordId
			? siblingIds.toArray().indexOf(input.afterRecordId) + 1
			: siblingIds.length;
		const before = insertAt > 0 ? recordOrder(doc, siblingIds.get(insertAt - 1)) : null;
		const after = insertAt < siblingIds.length ? recordOrder(doc, siblingIds.get(insertAt)) : null;
		const order = generateKeyBetween(before, after);

		const yrecord = new Y.Map<unknown>();
		yrecord.set('id', id);
		yrecord.set('parentId', input.parentId);
		yrecord.set('order', order);
		yrecord.set('createdBy', actor);
		yrecord.set('createdAt', now);
		yrecord.set('lastEditedBy', actor);
		yrecord.set('lastEditedAt', now);

		if (kind === 'document') {
			yrecord.set('blockType', input.blockType ?? 'paragraph');
			yrecord.set('content', new Y.Text());
		} else {
			yrecord.set('isCollectionRow', true);
			for (const [key, value] of Object.entries(input.properties ?? {})) {
				yrecord.set(PROP_PREFIX + key, value);
			}
		}

		recordsMap(doc).set(id, yrecord);
		siblingIds.insert(insertAt, [id]);

		return readRecord(yrecord);
	});
}

function recordOrder(doc: Y.Doc, id: string): string | null {
	const yrecord = recordsMap(doc).get(id) as Y.Map<unknown> | undefined;
	return (yrecord?.get('order') as string) ?? null;
}

export function updateRecordContent(
	doc: Y.Doc,
	id: string,
	content: RichText,
	actor: ActorId
): WorkspaceRecord {
	const yrecord = recordsMap(doc).get(id) as Y.Map<unknown> | undefined;
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);
	const ytext = yrecord.get('content') as Y.Text | undefined;
	if (!ytext) throw new Error(`Record ${id} has no block content (is it a Collection row?)`);

	doc.transact(() => {
		applyRichTextToYText(ytext, content);
		yrecord.set('lastEditedBy', actor);
		yrecord.set('lastEditedAt', Date.now());
	});
	return readRecord(yrecord);
}

export function updateRecordProperties(
	doc: Y.Doc,
	id: string,
	properties: Record<string, PropertyValue>,
	actor: ActorId
): WorkspaceRecord {
	const yrecord = recordsMap(doc).get(id) as Y.Map<unknown> | undefined;
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);

	doc.transact(() => {
		for (const [key, value] of Object.entries(properties)) {
			yrecord.set(PROP_PREFIX + key, value);
		}
		yrecord.set('lastEditedBy', actor);
		yrecord.set('lastEditedAt', Date.now());
	});
	return readRecord(yrecord);
}

export function setBlockType(doc: Y.Doc, id: string, blockType: BlockType, actor: ActorId): void {
	const yrecord = recordsMap(doc).get(id) as Y.Map<unknown> | undefined;
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);
	doc.transact(() => {
		yrecord.set('blockType', blockType);
		yrecord.set('lastEditedBy', actor);
		yrecord.set('lastEditedAt', Date.now());
	});
}

export function deleteRecord(doc: Y.Doc, id: string): void {
	doc.transact(() => {
		const yrecord = recordsMap(doc).get(id) as Y.Map<unknown> | undefined;
		if (!yrecord) return;
		const parentId = yrecord.get('parentId') as string;
		const kind = parentKindOf(doc, parentId);
		if (kind) {
			const siblingIds = parentRecordIds(doc, parentId, kind);
			const idx = siblingIds.toArray().indexOf(id);
			if (idx !== -1) siblingIds.delete(idx, 1);
		}
		recordsMap(doc).delete(id);
	});
}

export function listRecordsForParent(doc: Y.Doc, parentId: string): WorkspaceRecord[] {
	const kind = parentKindOf(doc, parentId);
	if (!kind) return [];
	const ids = parentRecordIds(doc, parentId, kind).toArray();
	return ids.map((id) => getRecord(doc, id)).filter((r): r is WorkspaceRecord => r !== undefined);
}
