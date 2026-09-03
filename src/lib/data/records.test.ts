import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
	addSelectOption,
	buildDocumentTree,
	coercePropertyValue,
	countRecordsWithProperty,
	countRecordsWithSelectOption,
	copyCollectionVerbatim,
	copyDocumentVerbatim,
	createCollection,
	createDocument,
	createRecord,
	deleteCollection,
	deleteCollectionProperty,
	deleteDocument,
	deleteRecord,
	deleteSelectOption,
	duplicateCollectionProperty,
	getCollection,
	getDocument,
	getRecord,
	getRecordYText,
	listCollections,
	listDocuments,
	listRecordsForParent,
	moveSelectOption,
	NotFoundError,
	patchRecordViewConfig,
	previewCollectionPropertyTypeChange,
	reorderRecord,
	resolvePrimaryField,
	setBlockType,
	setPrimaryField,
	setRecordChecked,
	setRecordCollapsed,
	setRecordReferencedId,
	setRecordViewConfig,
	touchRecordEditor,
	updateCollectionProperty,
	updateCollectionSchema,
	updateCollectionTitle,
	updateDocumentParent,
	updateDocumentTitle,
	updateRecordContent,
	updateRecordProperties,
	updateSelectOption,
	ValidationError
} from './records';
import { yTextToRichText } from './richtext';
import type { ActorId } from './types';

const human: ActorId = { kind: 'human', userId: 'brylie' };
const agent: ActorId = { kind: 'agent', agentId: 'a1', name: 'Research Agent' };

describe('records: unified addressing', () => {
	it('addresses a Document block and a Collection row through the same API', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const collection = createCollection(doc, {
			title: 'Tasks',
			schema: [{ key: 'status', label: 'Status', type: 'select' }]
		});

		const block = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		const row = createRecord(
			doc,
			{ parentId: collection.id, properties: { status: { type: 'select', value: 'todo' } } },
			human
		);

		// Same read function works for both, regardless of which "view" created them.
		expect(getRecord(doc, block.id)?.parentId).toBe(document.id);
		expect(getRecord(doc, row.id)?.parentId).toBe(collection.id);
		expect(getRecord(doc, row.id)?.properties?.status).toEqual({ type: 'select', value: 'todo' });
	});

	it('lists documents and collections independently, with zero migration needed for new views', () => {
		const doc = new Y.Doc();
		createDocument(doc, { title: 'A' });
		createCollection(doc, { title: 'B', schema: [] });

		expect(listDocuments(doc)).toHaveLength(1);
		expect(listCollections(doc)).toHaveLength(1);
	});

	it('orders a Document block sequence and keeps it in sync on delete', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const first = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		const second = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		const third = createRecord(
			doc,
			{ parentId: document.id, blockType: 'paragraph', afterRecordId: first.id },
			human
		);

		expect(listRecordsForParent(doc, document.id).map((r) => r.id)).toEqual([
			first.id,
			third.id,
			second.id
		]);

		deleteRecord(doc, third.id);
		expect(listRecordsForParent(doc, document.id).map((r) => r.id)).toEqual([first.id, second.id]);
	});
});

describe('document hierarchy and tree', () => {
	it('creates nested documents and builds tree hierarchy correctly', () => {
		const doc = new Y.Doc();
		const parent1 = createDocument(doc, { title: 'Architecture' });
		const child1 = createDocument(doc, {
			title: 'Storage layer',
			parentDocumentId: parent1.id
		});
		const child2 = createDocument(doc, {
			title: 'CRDT Sync',
			parentDocumentId: parent1.id,
			afterDocumentId: child1.id
		});
		const grandchild = createDocument(doc, {
			title: 'Awareness protocol',
			parentDocumentId: child2.id
		});
		createDocument(doc, { title: 'Design System' });

		const all = listDocuments(doc);
		expect(all).toHaveLength(5);

		const tree = buildDocumentTree(all);
		expect(tree).toHaveLength(2); // parent1 and Design System
		expect(tree[0].id).toBe(parent1.id);
		expect(tree[0].level).toBe(0);
		expect(tree[0].children).toHaveLength(2);
		expect(tree[0].children[0].id).toBe(child1.id);
		expect(tree[0].children[0].level).toBe(1);
		expect(tree[0].children[1].id).toBe(child2.id);
		expect(tree[0].children[1].level).toBe(1);
		expect(tree[0].children[1].children).toHaveLength(1);
		expect(tree[0].children[1].children[0].id).toBe(grandchild.id);
		expect(tree[0].children[1].children[0].level).toBe(2);
	});

	it('deleting parent document recursively deletes child documents', () => {
		const doc = new Y.Doc();
		const parent = createDocument(doc, { title: 'Parent' });
		createDocument(doc, { title: 'Child', parentDocumentId: parent.id });

		deleteDocument(doc, parent.id);
		expect(listDocuments(doc)).toHaveLength(0);
	});
});

describe('records: CRDT merge acceptance criteria', () => {
	it('merges concurrent overlapping bold/italic formatting with no corrupted or lost marks', () => {
		const docA = new Y.Doc();
		const document = createDocument(docA, { title: 'Notes' });
		const block = createRecord(docA, { parentId: document.id, blockType: 'paragraph' }, human);
		updateRecordContent(docA, block.id, { runs: [{ text: 'hello world', marks: {} }] }, human);

		const docB = new Y.Doc();
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

		const ytextA = (docA.getMap('records').get(block.id) as Y.Map<unknown>).get(
			'content'
		) as Y.Text;
		const ytextB = (docB.getMap('records').get(block.id) as Y.Map<unknown>).get(
			'content'
		) as Y.Text;

		// Replica A bolds "hello", replica B italicizes "lo world" — overlapping on "lo".
		docA.transact(() => ytextA.format(0, 5, { bold: true }));
		docB.transact(() => ytextB.format(3, 8, { italic: true }));

		// Sync both directions.
		const updateFromA = Y.encodeStateAsUpdate(docA);
		const updateFromB = Y.encodeStateAsUpdate(docB);
		Y.applyUpdate(docB, updateFromA);
		Y.applyUpdate(docA, updateFromB);

		const richTextA = yTextToRichText(ytextA);
		const richTextB = yTextToRichText(ytextB);

		// Both replicas converge to the same merged result.
		expect(richTextA).toEqual(richTextB);

		const plain = richTextA.runs.map((r) => r.text).join('');
		expect(plain).toBe('hello world');

		// "hel" is bold only, "lo" is bold+italic (the overlap), " world" tail is italic only.
		const bolded = richTextA.runs
			.filter((r) => r.marks.bold)
			.map((r) => r.text)
			.join('');
		const italicized = richTextA.runs
			.filter((r) => r.marks.italic)
			.map((r) => r.text)
			.join('');
		const both = richTextA.runs
			.filter((r) => r.marks.bold && r.marks.italic)
			.map((r) => r.text)
			.join('');

		expect(bolded).toBe('hello');
		expect(italicized).toBe('lo world');
		expect(both).toBe('lo');
	});

	it('merges concurrent property edits on different fields of the same row', () => {
		const docA = new Y.Doc();
		const collection = createCollection(docA, {
			title: 'Tasks',
			schema: [
				{ key: 'status', label: 'Status', type: 'select' },
				{ key: 'owner', label: 'Owner', type: 'text' }
			]
		});
		const row = createRecord(
			docA,
			{ parentId: collection.id, properties: { status: { type: 'select', value: 'todo' } } },
			human
		);

		const docB = new Y.Doc();
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

		updateRecordProperties(docA, row.id, { status: { type: 'select', value: 'done' } }, human);
		updateRecordProperties(docB, row.id, { owner: { type: 'text', value: 'Brylie' } }, agent);

		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
		Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

		const merged = getRecord(docA, row.id);
		expect(merged?.properties?.status).toEqual({ type: 'select', value: 'done' });
		expect(merged?.properties?.owner).toEqual({ type: 'text', value: 'Brylie' });
	});

	// Issue #71: viewConfig was previously stored as one whole-value Y.Map
	// entry, so two actors patching different members concurrently (one's
	// filter change, another's sort change) would resolve via last-write-wins
	// on the *entire* object — whichever patch's transaction landed later
	// would silently reintroduce its own stale copy of the member it didn't
	// touch, dropping the other actor's edit. patchRecordViewConfig now writes
	// each member to its own `viewConfig:<field>` entry, so this merges
	// per-member instead, the same way updateRecordProperties already does
	// for row properties (previous test).
	it('merges concurrent viewConfig patches on different members of the same collection_view block', () => {
		const docA = new Y.Doc();
		const collection = createCollection(docA, {
			title: 'Tasks',
			schema: [{ key: 'status', label: 'Status', type: 'select' }]
		});
		const document = createDocument(docA, { title: 'Doc' });
		const block = createRecord(
			docA,
			{
				parentId: document.id,
				blockType: 'collection_view',
				referencedRecordId: collection.id,
				viewConfig: { viewType: 'board', groupBy: 'status' }
			},
			human
		);

		const docB = new Y.Doc();
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

		patchRecordViewConfig(
			docA,
			block.id,
			{ filters: [{ propertyKey: 'status', op: 'is', value: 'todo' }] },
			human
		);
		patchRecordViewConfig(
			docB,
			block.id,
			{ sort: { mode: 'property', propertyKey: 'status', direction: 'asc' } },
			agent
		);

		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
		Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

		const expected = {
			viewType: 'board',
			groupBy: 'status',
			filters: [{ propertyKey: 'status', op: 'is', value: 'todo' }],
			sort: { mode: 'property', propertyKey: 'status', direction: 'asc' }
		};
		// Both replicas converge to the same merged result, not just the one
		// that happened to receive the other's update second.
		expect(getRecord(docA, block.id)?.viewConfig).toEqual(expected);
		expect(getRecord(docB, block.id)?.viewConfig).toEqual(expected);
	});
});

describe('documents: title, parent, and delete edge cases', () => {
	it('updateDocumentTitle renames a document', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Old' });
		updateDocumentTitle(doc, document.id, 'New');
		expect(getDocument(doc, document.id)?.title).toBe('New');
	});

	it('updateDocumentTitle throws NotFoundError for a nonexistent document', () => {
		const doc = new Y.Doc();
		expect(() => updateDocumentTitle(doc, 'missing', 'x')).toThrow(NotFoundError);
	});

	it('updateDocumentParent throws NotFoundError for a nonexistent document', () => {
		const doc = new Y.Doc();
		expect(() => updateDocumentParent(doc, 'missing')).toThrow(NotFoundError);
	});

	it('updateDocumentParent inserts between two existing siblings via afterDocumentId', () => {
		const doc = new Y.Doc();
		const a = createDocument(doc, { title: 'A' });
		const b = createDocument(doc, { title: 'B' });
		const c = createDocument(doc, { title: 'C' });

		updateDocumentParent(doc, c.id, undefined, a.id);

		expect(listDocuments(doc).map((d) => d.id)).toEqual([a.id, c.id, b.id]);
	});

	it('updateDocumentParent falls back to end-of-siblings order when afterDocumentId is not a real sibling', () => {
		const doc = new Y.Doc();
		const a = createDocument(doc, { title: 'A' });
		const b = createDocument(doc, { title: 'B' });

		expect(() => updateDocumentParent(doc, b.id, undefined, 'not-a-real-id')).not.toThrow();
		expect(listDocuments(doc).map((d) => d.id)).toContain(a.id);
	});

	it('updateDocumentParent reparents under a new document and back to top-level', () => {
		const doc = new Y.Doc();
		const folder = createDocument(doc, { title: 'Folder' });
		const child = createDocument(doc, { title: 'Child' });

		updateDocumentParent(doc, child.id, folder.id);
		expect(getDocument(doc, child.id)?.parentDocumentId).toBe(folder.id);

		updateDocumentParent(doc, child.id);
		expect(getDocument(doc, child.id)?.parentDocumentId).toBeUndefined();
	});

	it('createDocument treats an explicit empty-string parentDocumentId the same as omitted (root-level, ordered among real root siblings)', () => {
		const doc = new Y.Doc();
		const rootA = createDocument(doc, { title: 'Root A' });
		const nested = createDocument(doc, { title: 'Nested', parentDocumentId: rootA.id });

		const document = createDocument(doc, { title: 'New', parentDocumentId: '' });

		expect(document.parentDocumentId).toBeUndefined();
		expect(getDocument(doc, document.id)?.parentDocumentId).toBeUndefined();
		// Ordered after the real root sibling, not computed against an empty
		// (parentDocumentId === '') sibling set that excludes it.
		expect(document.order > rootA.order).toBe(true);
		expect(document.id).not.toBe(nested.id);
	});

	it('updateDocumentParent treats an explicit empty-string parentDocumentId the same as omitted (moves to root, ordered among real root siblings)', () => {
		const doc = new Y.Doc();
		const folder = createDocument(doc, { title: 'Folder' });
		const rootSibling = createDocument(doc, { title: 'Root Sibling' });
		const child = createDocument(doc, { title: 'Child', parentDocumentId: folder.id });

		updateDocumentParent(doc, child.id, '');

		expect(getDocument(doc, child.id)?.parentDocumentId).toBeUndefined();
		// Ordered after the real root sibling, not computed against an empty
		// (parentDocumentId === '') sibling set that excludes it.
		expect(getDocument(doc, child.id)!.order > rootSibling.order).toBe(true);
	});

	it('deleteDocument is a no-op for a nonexistent id', () => {
		const doc = new Y.Doc();
		expect(() => deleteDocument(doc, 'missing')).not.toThrow();
	});
});

describe('collections: title, schema, and delete edge cases', () => {
	it('updateCollectionTitle renames a collection', () => {
		const doc = new Y.Doc();
		const collection = createCollection(doc, { title: 'Old', schema: [] });
		updateCollectionTitle(doc, collection.id, 'New');
		expect(getCollection(doc, collection.id)?.title).toBe('New');
	});

	it('updateCollectionTitle throws NotFoundError for a nonexistent collection', () => {
		const doc = new Y.Doc();
		expect(() => updateCollectionTitle(doc, 'missing', 'x')).toThrow(NotFoundError);
	});

	it('updateCollectionSchema replaces the schema', () => {
		const doc = new Y.Doc();
		const collection = createCollection(doc, { title: 'Tasks', schema: [] });
		const schema = [{ key: 'status', label: 'Status', type: 'select' as const }];
		updateCollectionSchema(doc, collection.id, schema);
		expect(getCollection(doc, collection.id)?.schema).toEqual(schema);
	});

	it('updateCollectionSchema throws NotFoundError for a nonexistent collection', () => {
		const doc = new Y.Doc();
		expect(() => updateCollectionSchema(doc, 'missing', [])).toThrow(NotFoundError);
	});

	it('deleteCollection removes it and its rows', () => {
		const doc = new Y.Doc();
		const collection = createCollection(doc, { title: 'Tasks', schema: [] });
		const row = createRecord(doc, { parentId: collection.id, properties: {} }, human);

		deleteCollection(doc, collection.id);

		expect(getCollection(doc, collection.id)).toBeUndefined();
		expect(getRecord(doc, row.id)).toBeUndefined();
	});

	it('deleteCollection is a no-op for a nonexistent id', () => {
		const doc = new Y.Doc();
		expect(() => deleteCollection(doc, 'missing')).not.toThrow();
	});

	it('getCollection returns undefined for a nonexistent id', () => {
		const doc = new Y.Doc();
		expect(getCollection(doc, 'missing')).toBeUndefined();
	});
});

describe('coercePropertyValue', () => {
	it('returns the value unchanged when the type already matches', () => {
		const value = { type: 'text' as const, value: 'hi' };
		expect(coercePropertyValue(value, 'text')).toBe(value);
	});

	it('converts number/date/checkbox to text losslessly', () => {
		expect(coercePropertyValue({ type: 'number', value: 7 }, 'text')).toEqual({
			type: 'text',
			value: '7'
		});
		expect(coercePropertyValue({ type: 'date', value: '2026-01-01' }, 'text')).toEqual({
			type: 'text',
			value: '2026-01-01'
		});
		expect(coercePropertyValue({ type: 'checkbox', value: true }, 'text')).toEqual({
			type: 'text',
			value: 'true'
		});
	});

	it('parses a numeric-looking text value into number, and rejects a non-numeric one', () => {
		expect(coercePropertyValue({ type: 'text', value: '42' }, 'number')).toEqual({
			type: 'number',
			value: 42
		});
		expect(coercePropertyValue({ type: 'text', value: 'abc' }, 'number')).toBeUndefined();
		expect(coercePropertyValue({ type: 'text', value: '' }, 'number')).toBeUndefined();
	});

	it('parses "true"/"false" text into checkbox, and rejects anything else', () => {
		expect(coercePropertyValue({ type: 'text', value: 'true' }, 'checkbox')).toEqual({
			type: 'checkbox',
			value: true
		});
		expect(coercePropertyValue({ type: 'text', value: 'false' }, 'checkbox')).toEqual({
			type: 'checkbox',
			value: false
		});
		expect(coercePropertyValue({ type: 'text', value: 'maybe' }, 'checkbox')).toBeUndefined();
	});

	it('has no safe conversion into date/select/relation', () => {
		expect(coercePropertyValue({ type: 'text', value: '2026-01-01' }, 'date')).toBeUndefined();
		expect(coercePropertyValue({ type: 'text', value: 'x' }, 'select')).toBeUndefined();
		expect(coercePropertyValue({ type: 'text', value: 'x' }, 'relation')).toBeUndefined();
	});
});

describe('collection field lifecycle: rename, retype, duplicate, delete', () => {
	function setupCollection(doc: Y.Doc) {
		const collection = createCollection(doc, {
			title: 'Tasks',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		const withValue = createRecord(
			doc,
			{ parentId: collection.id, properties: { name: { type: 'text', value: 'Alice' } } },
			human
		);
		const withoutValue = createRecord(doc, { parentId: collection.id, properties: {} }, human);
		return { collection, withValue, withoutValue };
	}

	it('updateCollectionProperty renames a field without touching its type or values', () => {
		const doc = new Y.Doc();
		const { collection, withValue } = setupCollection(doc);

		updateCollectionProperty(doc, collection.id, 'name', { label: 'Full name' });

		expect(getCollection(doc, collection.id)?.schema).toEqual([
			{ key: 'name', label: 'Full name', type: 'text', options: undefined }
		]);
		expect(getRecord(doc, withValue.id)?.properties?.name).toEqual({
			type: 'text',
			value: 'Alice'
		});
	});

	it('updateCollectionProperty retypes a field and migrates coercible values, clearing the rest', () => {
		const doc = new Y.Doc();
		const collection = createCollection(doc, {
			title: 'Tasks',
			schema: [{ key: 'qty', label: 'Qty', type: 'text' }]
		});
		const numeric = createRecord(
			doc,
			{ parentId: collection.id, properties: { qty: { type: 'text', value: '5' } } },
			human
		);
		const nonNumeric = createRecord(
			doc,
			{ parentId: collection.id, properties: { qty: { type: 'text', value: 'lots' } } },
			human
		);

		updateCollectionProperty(doc, collection.id, 'qty', { type: 'number' });

		expect(getCollection(doc, collection.id)?.schema[0].type).toBe('number');
		expect(getRecord(doc, numeric.id)?.properties?.qty).toEqual({ type: 'number', value: 5 });
		expect(getRecord(doc, nonNumeric.id)?.properties?.qty).toBeUndefined();
	});

	it('updateCollectionProperty throws NotFoundError for an unknown collection or field', () => {
		const doc = new Y.Doc();
		const { collection } = setupCollection(doc);
		expect(() => updateCollectionProperty(doc, 'missing', 'name', { label: 'x' })).toThrow(
			NotFoundError
		);
		expect(() => updateCollectionProperty(doc, collection.id, 'missing', { label: 'x' })).toThrow(
			NotFoundError
		);
	});

	it('previewCollectionPropertyTypeChange reports how many filled records would lose their value', () => {
		const doc = new Y.Doc();
		const collection = createCollection(doc, {
			title: 'Tasks',
			schema: [{ key: 'qty', label: 'Qty', type: 'text' }]
		});
		createRecord(
			doc,
			{ parentId: collection.id, properties: { qty: { type: 'text', value: '5' } } },
			human
		);
		createRecord(
			doc,
			{ parentId: collection.id, properties: { qty: { type: 'text', value: 'lots' } } },
			human
		);
		createRecord(doc, { parentId: collection.id, properties: {} }, human);

		expect(previewCollectionPropertyTypeChange(doc, collection.id, 'qty', 'number')).toEqual({
			affected: 1,
			total: 2
		});
	});

	it('duplicateCollectionProperty clones the field definition and copies existing values', () => {
		const doc = new Y.Doc();
		const { collection, withValue, withoutValue } = setupCollection(doc);

		const copy = duplicateCollectionProperty(doc, collection.id, 'name');

		expect(copy.label).toBe('Name copy');
		expect(copy.key).not.toBe('name');
		const schema = getCollection(doc, collection.id)?.schema ?? [];
		expect(schema.map((p) => p.key)).toEqual(['name', copy.key]);
		expect(getRecord(doc, withValue.id)?.properties?.[copy.key]).toEqual({
			type: 'text',
			value: 'Alice'
		});
		expect(getRecord(doc, withoutValue.id)?.properties?.[copy.key]).toBeUndefined();
	});

	it('duplicateCollectionProperty throws NotFoundError for an unknown collection or field', () => {
		const doc = new Y.Doc();
		const { collection } = setupCollection(doc);
		expect(() => duplicateCollectionProperty(doc, 'missing', 'name')).toThrow(NotFoundError);
		expect(() => duplicateCollectionProperty(doc, collection.id, 'missing')).toThrow(NotFoundError);
	});

	it('countRecordsWithProperty counts only records holding a value for that key', () => {
		const doc = new Y.Doc();
		const { collection } = setupCollection(doc);
		expect(countRecordsWithProperty(doc, collection.id, 'name')).toBe(1);
		expect(countRecordsWithProperty(doc, collection.id, 'missing-key')).toBe(0);
	});

	it('deleteCollectionProperty removes the field from schema and strips its value off every record', () => {
		const doc = new Y.Doc();
		const { collection, withValue, withoutValue } = setupCollection(doc);

		deleteCollectionProperty(doc, collection.id, 'name');

		expect(getCollection(doc, collection.id)?.schema).toEqual([]);
		expect(getRecord(doc, withValue.id)?.properties?.name).toBeUndefined();
		expect(getRecord(doc, withoutValue.id)?.properties?.name).toBeUndefined();
	});

	it('deleteCollectionProperty repairs an embedded collection_view block that referenced the deleted field', () => {
		const doc = new Y.Doc();
		const { collection } = setupCollection(doc);
		const document = createDocument(doc, { title: 'Doc' });
		const block = createRecord(
			doc,
			{
				parentId: document.id,
				blockType: 'collection_view',
				referencedRecordId: collection.id,
				viewConfig: {
					viewType: 'table',
					filters: [{ propertyKey: 'name', op: 'is', value: 'x' }],
					visibleProperties: ['name'],
					groupBy: 'name',
					sort: { mode: 'property', propertyKey: 'name', direction: 'asc' }
				}
			},
			human
		);

		deleteCollectionProperty(doc, collection.id, 'name');

		expect(getRecord(doc, block.id)?.viewConfig).toEqual({
			viewType: 'table',
			filters: [],
			visibleProperties: [],
			groupBy: undefined,
			sort: { mode: 'manual' }
		});
	});

	it('deleteCollectionProperty repairs an embed living in a separate documentsDoc (#120: Collections are sharded, Documents are not)', () => {
		const collectionDoc = new Y.Doc();
		const { collection } = setupCollection(collectionDoc);
		const documentsDoc = new Y.Doc();
		const document = createDocument(documentsDoc, { title: 'Doc' });
		const block = createRecord(
			documentsDoc,
			{
				parentId: document.id,
				blockType: 'collection_view',
				referencedRecordId: collection.id,
				viewConfig: { viewType: 'table', groupBy: 'name' }
			},
			human
		);

		deleteCollectionProperty(collectionDoc, collection.id, 'name', documentsDoc);

		expect(getRecord(documentsDoc, block.id)?.viewConfig?.groupBy).toBeUndefined();
	});

	it('deleteCollectionProperty leaves an embed that references a different collection untouched', () => {
		const doc = new Y.Doc();
		const { collection } = setupCollection(doc);
		const other = createCollection(doc, {
			title: 'Other',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		const document = createDocument(doc, { title: 'Doc' });
		const viewConfig = {
			viewType: 'table' as const,
			filters: [{ propertyKey: 'name', op: 'is' as const, value: 'x' }],
			visibleProperties: ['name'],
			groupBy: 'name',
			sort: { mode: 'property' as const, propertyKey: 'name', direction: 'asc' as const }
		};
		const block = createRecord(
			doc,
			{
				parentId: document.id,
				blockType: 'collection_view',
				referencedRecordId: other.id,
				viewConfig
			},
			human
		);

		deleteCollectionProperty(doc, collection.id, 'name');

		expect(getRecord(doc, block.id)?.viewConfig).toEqual(viewConfig);
	});

	it('deleteCollectionProperty throws NotFoundError for an unknown collection', () => {
		const doc = new Y.Doc();
		expect(() => deleteCollectionProperty(doc, 'missing', 'name')).toThrow(NotFoundError);
	});
});

describe('primary field: resolve, set, and migration on delete/retype (issue #96)', () => {
	function setupCollection(doc: Y.Doc) {
		return createCollection(doc, {
			title: 'Tasks',
			schema: [
				{ key: 'name', label: 'Name', type: 'text' },
				{ key: 'notes', label: 'Notes', type: 'text' },
				{ key: 'assignees', label: 'Assignees', type: 'relation' }
			]
		});
	}

	it('resolvePrimaryField falls back to the first text field when nothing is explicitly set', () => {
		const doc = new Y.Doc();
		const collection = setupCollection(doc);
		expect(resolvePrimaryField(collection.schema, undefined)?.key).toBe('name');
	});

	it('resolvePrimaryField returns undefined when no eligible field exists', () => {
		const schema = [{ key: 'assignees', label: 'Assignees', type: 'relation' as const }];
		expect(resolvePrimaryField(schema, undefined)).toBeUndefined();
	});

	it('resolvePrimaryField returns undefined when an eligible field exists but none is type text — the fallback only considers text fields', () => {
		const schema = [{ key: 'qty', label: 'Qty', type: 'number' as const }];
		expect(resolvePrimaryField(schema, undefined)).toBeUndefined();
	});

	it('setPrimaryField chooses an explicit field, overriding the first-text fallback', () => {
		const doc = new Y.Doc();
		const collection = setupCollection(doc);

		setPrimaryField(doc, collection.id, 'notes');

		const schema = getCollection(doc, collection.id)!.schema;
		expect(getCollection(doc, collection.id)?.primaryFieldKey).toBe('notes');
		expect(resolvePrimaryField(schema, 'notes')?.key).toBe('notes');
	});

	it('setPrimaryField(null) clears the explicit choice, reverting to the automatic fallback', () => {
		const doc = new Y.Doc();
		const collection = setupCollection(doc);
		setPrimaryField(doc, collection.id, 'notes');

		setPrimaryField(doc, collection.id, null);

		expect(getCollection(doc, collection.id)?.primaryFieldKey).toBeUndefined();
	});

	it('setPrimaryField rejects a relation field — it has no single display value of its own', () => {
		const doc = new Y.Doc();
		const collection = setupCollection(doc);
		expect(() => setPrimaryField(doc, collection.id, 'assignees')).toThrow(ValidationError);
		expect(getCollection(doc, collection.id)?.primaryFieldKey).toBeUndefined();
	});

	it('setPrimaryField throws NotFoundError for an unknown collection or field', () => {
		const doc = new Y.Doc();
		const collection = setupCollection(doc);
		expect(() => setPrimaryField(doc, 'missing', 'name')).toThrow(NotFoundError);
		expect(() => setPrimaryField(doc, collection.id, 'missing')).toThrow(NotFoundError);
	});

	it('reordering the schema does not change an explicitly chosen primary field', () => {
		const doc = new Y.Doc();
		const collection = setupCollection(doc);
		setPrimaryField(doc, collection.id, 'notes');

		const schema = getCollection(doc, collection.id)!.schema;
		updateCollectionSchema(doc, collection.id, [...schema].reverse());

		const reordered = getCollection(doc, collection.id)!;
		expect(resolvePrimaryField(reordered.schema, reordered.primaryFieldKey)?.key).toBe('notes');
	});

	it('deleteCollectionProperty clears primaryFieldKey when the deleted field was the primary', () => {
		const doc = new Y.Doc();
		const collection = setupCollection(doc);
		setPrimaryField(doc, collection.id, 'notes');

		deleteCollectionProperty(doc, collection.id, 'notes');

		expect(getCollection(doc, collection.id)?.primaryFieldKey).toBeUndefined();
		// Falls back to the remaining text field rather than showing no title.
		const schema = getCollection(doc, collection.id)!.schema;
		expect(resolvePrimaryField(schema, undefined)?.key).toBe('name');
	});

	it('deleteCollectionProperty leaves primaryFieldKey untouched when an unrelated field is deleted', () => {
		const doc = new Y.Doc();
		const collection = setupCollection(doc);
		setPrimaryField(doc, collection.id, 'notes');

		deleteCollectionProperty(doc, collection.id, 'assignees');

		expect(getCollection(doc, collection.id)?.primaryFieldKey).toBe('notes');
	});

	it('updateCollectionProperty clears primaryFieldKey when retyping it to an ineligible type', () => {
		const doc = new Y.Doc();
		const collection = setupCollection(doc);
		setPrimaryField(doc, collection.id, 'notes');

		updateCollectionProperty(doc, collection.id, 'notes', { type: 'relation' });

		expect(getCollection(doc, collection.id)?.primaryFieldKey).toBeUndefined();
	});

	it('updateCollectionProperty preserves primaryFieldKey when retyping it to another eligible type', () => {
		const doc = new Y.Doc();
		const collection = setupCollection(doc);
		setPrimaryField(doc, collection.id, 'notes');

		updateCollectionProperty(doc, collection.id, 'notes', { type: 'number' });

		expect(getCollection(doc, collection.id)?.primaryFieldKey).toBe('notes');
	});
});

describe('select option lifecycle: add, rename, recolor, reorder, delete (issue #94)', () => {
	function setupSelectCollection(doc: Y.Doc) {
		const collection = createCollection(doc, {
			title: 'Tasks',
			schema: [
				{
					key: 'status',
					label: 'Status',
					type: 'select',
					options: [
						{ id: 'todo', label: 'To do', color: 'oklch(60% 0.01 250)' },
						{ id: 'doing', label: 'Doing', color: 'oklch(62% 0.18 25)' },
						{ id: 'done', label: 'Done', color: 'oklch(65% 0.14 145)' }
					]
				}
			]
		});
		return { collection };
	}

	function statusOptions(doc: Y.Doc, collectionId: string) {
		return getCollection(doc, collectionId)?.schema[0].options ?? [];
	}

	it('addSelectOption appends with a fresh id and an auto-assigned color', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);

		const option = addSelectOption(doc, collection.id, 'status', 'Blocked');

		expect(option.label).toBe('Blocked');
		expect(option.color).toBeTruthy();
		const options = statusOptions(doc, collection.id);
		expect(options.map((o) => o.label)).toEqual(['To do', 'Doing', 'Done', 'Blocked']);
		expect(new Set(options.map((o) => o.id)).size).toBe(4);
	});

	it('addSelectOption rejects a blank label', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);
		expect(() => addSelectOption(doc, collection.id, 'status', '   ')).toThrow(ValidationError);
	});

	it('addSelectOption rejects a case-insensitive duplicate label', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);
		expect(() => addSelectOption(doc, collection.id, 'status', 'to do')).toThrow(ValidationError);
		expect(statusOptions(doc, collection.id)).toHaveLength(3);
	});

	it('addSelectOption throws NotFoundError for an unknown collection/field, ValidationError for a non-select field', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);
		expect(() => addSelectOption(doc, 'missing', 'status', 'x')).toThrow(NotFoundError);
		expect(() => addSelectOption(doc, collection.id, 'missing', 'x')).toThrow(NotFoundError);

		const withText = createCollection(doc, {
			title: 'Other',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		expect(() => addSelectOption(doc, withText.id, 'name', 'x')).toThrow(ValidationError);
	});

	it('updateSelectOption renames an option without touching its color or id', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);

		updateSelectOption(doc, collection.id, 'status', 'doing', { label: 'In progress' });

		expect(statusOptions(doc, collection.id)).toEqual([
			{ id: 'todo', label: 'To do', color: 'oklch(60% 0.01 250)' },
			{ id: 'doing', label: 'In progress', color: 'oklch(62% 0.18 25)' },
			{ id: 'done', label: 'Done', color: 'oklch(65% 0.14 145)' }
		]);
	});

	it('updateSelectOption recolors an option without touching its label', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);

		updateSelectOption(doc, collection.id, 'status', 'todo', { color: 'oklch(65% 0.15 350)' });

		expect(statusOptions(doc, collection.id)[0]).toEqual({
			id: 'todo',
			label: 'To do',
			color: 'oklch(65% 0.15 350)'
		});
	});

	it('updateSelectOption rejects renaming to a blank or already-used label, leaving the option unchanged', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);

		expect(() =>
			updateSelectOption(doc, collection.id, 'status', 'doing', { label: 'done' })
		).toThrow(ValidationError);
		expect(() => updateSelectOption(doc, collection.id, 'status', 'doing', { label: ' ' })).toThrow(
			ValidationError
		);
		expect(statusOptions(doc, collection.id)[1].label).toBe('Doing');
	});

	it('updateSelectOption allows re-saving an option under its own unchanged label', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);
		expect(() =>
			updateSelectOption(doc, collection.id, 'status', 'doing', { label: 'Doing' })
		).not.toThrow();
	});

	it('updateSelectOption throws NotFoundError for an unknown option', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);
		expect(() =>
			updateSelectOption(doc, collection.id, 'status', 'missing', { label: 'x' })
		).toThrow(NotFoundError);
	});

	it('moveSelectOption reorders within bounds and is the primitive behind Board column/dropdown/filter order', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);

		moveSelectOption(doc, collection.id, 'status', 'done', 0);

		expect(statusOptions(doc, collection.id).map((o) => o.id)).toEqual(['done', 'todo', 'doing']);
	});

	it('moveSelectOption clamps an out-of-range target index instead of throwing', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);

		moveSelectOption(doc, collection.id, 'status', 'todo', 99);

		expect(statusOptions(doc, collection.id).map((o) => o.id)).toEqual(['doing', 'done', 'todo']);
	});

	it('moveSelectOption is a no-op when the target index equals the current index', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);
		const before = statusOptions(doc, collection.id);

		moveSelectOption(doc, collection.id, 'status', 'doing', 1);

		expect(statusOptions(doc, collection.id)).toEqual(before);
	});

	it('countRecordsWithSelectOption counts only records currently set to that option', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);
		createRecord(
			doc,
			{ parentId: collection.id, properties: { status: { type: 'select', value: 'todo' } } },
			human
		);
		createRecord(
			doc,
			{ parentId: collection.id, properties: { status: { type: 'select', value: 'todo' } } },
			human
		);
		createRecord(
			doc,
			{ parentId: collection.id, properties: { status: { type: 'select', value: 'done' } } },
			human
		);
		createRecord(doc, { parentId: collection.id, properties: {} }, human);

		expect(countRecordsWithSelectOption(doc, collection.id, 'status', 'todo')).toBe(2);
		expect(countRecordsWithSelectOption(doc, collection.id, 'status', 'done')).toBe(1);
		expect(countRecordsWithSelectOption(doc, collection.id, 'status', 'missing')).toBe(0);
	});

	it('deleteSelectOption removes the option and clears it (to the documented unassigned state) on every record that held it, leaving other records untouched', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);
		const wasTodo = createRecord(
			doc,
			{ parentId: collection.id, properties: { status: { type: 'select', value: 'todo' } } },
			human
		);
		const wasDone = createRecord(
			doc,
			{ parentId: collection.id, properties: { status: { type: 'select', value: 'done' } } },
			human
		);

		deleteSelectOption(doc, collection.id, 'status', 'todo');

		expect(statusOptions(doc, collection.id).map((o) => o.id)).toEqual(['doing', 'done']);
		expect(getRecord(doc, wasTodo.id)?.properties?.status).toBeUndefined();
		expect(getRecord(doc, wasDone.id)?.properties?.status).toEqual({
			type: 'select',
			value: 'done'
		});
	});

	it('deleteSelectOption strips a filter referencing the deleted option from an embedded view, leaving groupBy/other filters alone', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);
		const document = createDocument(doc, { title: 'Doc' });
		const block = createRecord(
			doc,
			{
				parentId: document.id,
				blockType: 'collection_view',
				referencedRecordId: collection.id,
				viewConfig: {
					viewType: 'board',
					filters: [
						{ propertyKey: 'status', op: 'is', value: 'todo' },
						{ propertyKey: 'status', op: 'is_not', value: 'done' }
					],
					groupBy: 'status'
				}
			},
			human
		);

		deleteSelectOption(doc, collection.id, 'status', 'todo');

		expect(getRecord(doc, block.id)?.viewConfig).toEqual({
			viewType: 'board',
			filters: [{ propertyKey: 'status', op: 'is_not', value: 'done' }],
			groupBy: 'status'
		});
	});

	it('deleteSelectOption repairs an embed living in a separate documentsDoc (#120: Collections are sharded, Documents are not)', () => {
		const collectionDoc = new Y.Doc();
		const { collection } = setupSelectCollection(collectionDoc);
		const documentsDoc = new Y.Doc();
		const document = createDocument(documentsDoc, { title: 'Doc' });
		const block = createRecord(
			documentsDoc,
			{
				parentId: document.id,
				blockType: 'collection_view',
				referencedRecordId: collection.id,
				viewConfig: {
					viewType: 'board',
					filters: [{ propertyKey: 'status', op: 'is', value: 'todo' }],
					groupBy: 'status'
				}
			},
			human
		);

		deleteSelectOption(collectionDoc, collection.id, 'status', 'todo', documentsDoc);

		expect(getRecord(documentsDoc, block.id)?.viewConfig?.filters).toEqual([]);
	});

	it('deleteSelectOption is a no-op when the option is already gone', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);
		deleteSelectOption(doc, collection.id, 'status', 'missing');
		expect(statusOptions(doc, collection.id)).toHaveLength(3);
	});

	it('deleteSelectOption throws NotFoundError for an unknown collection or field', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);
		expect(() => deleteSelectOption(doc, 'missing', 'status', 'todo')).toThrow(NotFoundError);
		expect(() => deleteSelectOption(doc, collection.id, 'missing', 'todo')).toThrow(NotFoundError);
	});
});

describe('records: creation ordering, mutation, and not-found edge cases', () => {
	it('createRecord throws NotFoundError for an unknown parent', () => {
		const doc = new Y.Doc();
		expect(() => createRecord(doc, { parentId: 'missing', blockType: 'paragraph' }, human)).toThrow(
			NotFoundError
		);
	});

	it('createRecord inserts between two existing siblings via afterRecordId', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const first = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		const second = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		const middle = createRecord(
			doc,
			{ parentId: document.id, blockType: 'paragraph', afterRecordId: first.id },
			human
		);
		expect(listRecordsForParent(doc, document.id).map((r) => r.id)).toEqual([
			first.id,
			middle.id,
			second.id
		]);
	});

	it('createRecord defaults an empty properties object for a collection row with no properties given', () => {
		const doc = new Y.Doc();
		const collection = createCollection(doc, { title: 'Tasks', schema: [] });
		const row = createRecord(doc, { parentId: collection.id }, human);
		expect(getRecord(doc, row.id)?.properties).toEqual({});
	});

	it('updateRecordContent throws NotFoundError for an unknown record', () => {
		const doc = new Y.Doc();
		expect(() => updateRecordContent(doc, 'missing', { runs: [] }, human)).toThrow(NotFoundError);
	});

	it('updateRecordContent throws when the record has no block content (a collection row)', () => {
		const doc = new Y.Doc();
		const collection = createCollection(doc, { title: 'Tasks', schema: [] });
		const row = createRecord(doc, { parentId: collection.id, properties: {} }, human);
		expect(() => updateRecordContent(doc, row.id, { runs: [] }, human)).toThrow(
			/has no block content/
		);
	});

	it('updateRecordProperties throws NotFoundError for an unknown record', () => {
		const doc = new Y.Doc();
		expect(() =>
			updateRecordProperties(doc, 'missing', { status: { type: 'text', value: 'x' } }, human)
		).toThrow(NotFoundError);
	});

	it("setBlockType changes a block's type and throws NotFoundError for an unknown record", () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		setBlockType(doc, block.id, 'heading_1', human);
		expect(getRecord(doc, block.id)?.blockType).toBe('heading_1');
		expect(() => setBlockType(doc, 'missing', 'heading_1', human)).toThrow(NotFoundError);
	});

	it('setRecordChecked toggles a to_do block and throws NotFoundError for an unknown record', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'to_do' }, human);
		setRecordChecked(doc, block.id, true, human);
		expect(getRecord(doc, block.id)?.checked).toBe(true);
		expect(() => setRecordChecked(doc, 'missing', true, human)).toThrow(NotFoundError);
	});

	it('setRecordCollapsed toggles a toggle block and throws NotFoundError for an unknown record', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'toggle' }, human);
		setRecordCollapsed(doc, block.id, true, human);
		expect(getRecord(doc, block.id)?.collapsed).toBe(true);
		expect(() => setRecordCollapsed(doc, 'missing', true, human)).toThrow(NotFoundError);
	});

	it('setRecordReferencedId points a page_link block at another document and throws NotFoundError for an unknown record', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const target = createDocument(doc, { title: 'Target' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'page_link' }, human);
		setRecordReferencedId(doc, block.id, target.id, human);
		expect(getRecord(doc, block.id)?.referencedRecordId).toBe(target.id);
		expect(() => setRecordReferencedId(doc, 'missing', target.id, human)).toThrow(NotFoundError);
	});

	it("setRecordViewConfig stores a collection_view block's config and throws NotFoundError for an unknown record", () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'collection_view' }, human);
		setRecordViewConfig(doc, block.id, { viewType: 'board', groupBy: 'status' }, human);
		expect(getRecord(doc, block.id)?.viewConfig).toEqual({ viewType: 'board', groupBy: 'status' });
		expect(() => setRecordViewConfig(doc, 'missing', { viewType: 'table' }, human)).toThrow(
			NotFoundError
		);
	});

	it('setRecordViewConfig fully replaces a prior config, clearing any member absent from the new one', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'collection_view' }, human);
		setRecordViewConfig(
			doc,
			block.id,
			{
				viewType: 'table',
				filters: [{ propertyKey: 'status', op: 'is', value: 'todo' }],
				groupBy: 'status'
			},
			human
		);
		setRecordViewConfig(doc, block.id, { viewType: 'table', sort: { mode: 'manual' } }, human);
		expect(getRecord(doc, block.id)?.viewConfig).toEqual({
			viewType: 'table',
			sort: { mode: 'manual' }
		});
	});

	it("patchRecordViewConfig merges only the named members, leaving the rest of a collection_view block's config untouched", () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(
			doc,
			{
				parentId: document.id,
				blockType: 'collection_view',
				viewConfig: {
					viewType: 'board',
					filters: [{ propertyKey: 'status', op: 'is', value: 'todo' }],
					groupBy: 'status'
				}
			},
			human
		);

		patchRecordViewConfig(
			doc,
			block.id,
			{ sort: { mode: 'property', propertyKey: 'status', direction: 'asc' } },
			human
		);
		expect(getRecord(doc, block.id)?.viewConfig).toEqual({
			viewType: 'board',
			filters: [{ propertyKey: 'status', op: 'is', value: 'todo' }],
			groupBy: 'status',
			sort: { mode: 'property', propertyKey: 'status', direction: 'asc' }
		});

		// A member explicitly named with an `undefined` value clears it rather
		// than being treated as "not part of this patch".
		patchRecordViewConfig(doc, block.id, { groupBy: undefined }, human);
		expect(getRecord(doc, block.id)?.viewConfig?.groupBy).toBeUndefined();
		expect(getRecord(doc, block.id)?.viewConfig?.filters).toEqual([
			{ propertyKey: 'status', op: 'is', value: 'todo' }
		]);

		expect(() => patchRecordViewConfig(doc, 'missing', { groupBy: 'status' }, human)).toThrow(
			NotFoundError
		);
	});

	it('reads a pre-#183 legacy whole-value viewConfig, and patchRecordViewConfig migrates it into per-member entries on first write', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'collection_view' }, human);

		// Simulate a record persisted before #183: the whole config under one
		// `viewConfig` key, bypassing writeViewConfig/setRecordViewConfig
		// entirely so this doesn't just re-exercise the new write path.
		const yrecord = (doc.getMap('records') as Y.Map<Y.Map<unknown>>).get(block.id)!;
		const legacyConfig = {
			viewType: 'board' as const,
			filters: [{ propertyKey: 'status', op: 'is' as const, value: 'todo' }],
			groupBy: 'status'
		};
		yrecord.set('viewConfig', legacyConfig);

		// readViewConfig falls back to the legacy key read-only — an existing
		// embed doesn't look unconfigured just because this PR shipped.
		expect(getRecord(doc, block.id)?.viewConfig).toEqual(legacyConfig);
		expect(yrecord.has('viewConfig:viewType')).toBe(false);

		patchRecordViewConfig(doc, block.id, { sort: { mode: 'manual' } }, human);

		// The patch's first write migrates the legacy value into prefixed
		// entries (and removes the legacy key) before applying itself, so the
		// patch lands on top of the migrated data instead of being shadowed by
		// the still-present legacy object on the next read.
		expect(yrecord.has('viewConfig')).toBe(false);
		expect(getRecord(doc, block.id)?.viewConfig).toEqual({
			...legacyConfig,
			sort: { mode: 'manual' }
		});
	});

	it('createRecord accepts an initial viewConfig for a collection_view block', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(
			doc,
			{ parentId: document.id, blockType: 'collection_view', viewConfig: { viewType: 'calendar' } },
			human
		);
		expect(getRecord(doc, block.id)?.viewConfig).toEqual({ viewType: 'calendar' });
	});

	it('deleteRecord is a no-op for a nonexistent id', () => {
		const doc = new Y.Doc();
		expect(() => deleteRecord(doc, 'missing')).not.toThrow();
	});

	it('getRecordYText returns the Y.Text for a block and undefined for an unknown record', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		expect(getRecordYText(doc, block.id)).toBeInstanceOf(Y.Text);
		expect(getRecordYText(doc, 'missing')).toBeUndefined();
	});

	it('touchRecordEditor updates lastEditedBy/At and no-ops for an unknown record', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		touchRecordEditor(doc, block.id, agent);
		expect(getRecord(doc, block.id)?.lastEditedBy).toEqual(agent);
		expect(() => touchRecordEditor(doc, 'missing', agent)).not.toThrow();
	});

	it('listRecordsForParent returns an empty list for an unknown parent', () => {
		const doc = new Y.Doc();
		expect(listRecordsForParent(doc, 'missing')).toEqual([]);
	});
});

describe('reorderRecord: block drag-and-drop repositioning (#40)', () => {
	function setup() {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const a = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		const b = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		const c = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		const d = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		return { doc, document, a, b, c, d };
	}

	function ids(doc: Y.Doc, parentId: string): string[] {
		return listRecordsForParent(doc, parentId).map((r) => r.id);
	}

	it('moves a block to the very start when afterRecordId is omitted', () => {
		const { doc, document, a, b, c, d } = setup();
		reorderRecord(doc, d.id);
		expect(ids(doc, document.id)).toEqual([d.id, a.id, b.id, c.id]);
	});

	it('moves a block to the middle via afterRecordId', () => {
		const { doc, document, a, b, c, d } = setup();
		reorderRecord(doc, a.id, b.id);
		expect(ids(doc, document.id)).toEqual([b.id, a.id, c.id, d.id]);
	});

	it('moves a block to the very end via the last sibling as afterRecordId', () => {
		const { doc, document, a, b, c, d } = setup();
		reorderRecord(doc, a.id, d.id);
		expect(ids(doc, document.id)).toEqual([b.id, c.id, d.id, a.id]);
	});

	it('changes only position — content, blockType, and provenance are untouched', () => {
		const { doc, a, b } = setup();
		const ytext = getRecordYText(doc, a.id)!;
		doc.transact(() => ytext.insert(0, 'hello'));
		const before = getRecord(doc, a.id)!;

		reorderRecord(doc, a.id, b.id);

		const after = getRecord(doc, a.id)!;
		expect(after.blockType).toBe(before.blockType);
		expect(yTextToRichText(getRecordYText(doc, a.id)!)).toEqual(yTextToRichText(ytext));
		expect(after.createdBy).toEqual(before.createdBy);
		expect(after.lastEditedBy).toEqual(before.lastEditedBy);
		expect(after.lastEditedAt).toEqual(before.lastEditedAt);
	});

	it('throws NotFoundError for an unknown record id', () => {
		const { doc } = setup();
		expect(() => reorderRecord(doc, 'missing')).toThrow(NotFoundError);
	});

	it('throws NotFoundError when afterRecordId is not an existing sibling', () => {
		const { doc, a } = setup();
		expect(() => reorderRecord(doc, a.id, 'missing')).toThrow(NotFoundError);
	});

	it('throws ValidationError when afterRecordId is the record itself', () => {
		const { doc, a } = setup();
		expect(() => reorderRecord(doc, a.id, a.id)).toThrow(ValidationError);
	});

	it('throws ValidationError for a Collection row (only Document blocks are reorderable)', () => {
		const doc = new Y.Doc();
		const collection = createCollection(doc, { title: 'Tasks', schema: [] });
		const row = createRecord(doc, { parentId: collection.id, properties: {} }, human);
		expect(() => reorderRecord(doc, row.id)).toThrow(ValidationError);
	});

	it('deleteRecord removes every occurrence of an id, cleaning up a leftover duplicate from a concurrent move', () => {
		const { doc, document, a, b, c, d } = setup();
		// Simulate the leftover a concurrent reorderRecord move of the same
		// block by two actors can produce (see reorderRecord's doc comment):
		// two entries for `a` in the same recordIds array.
		const ymeta = doc.getMap('documents').get(document.id) as Y.Map<unknown>;
		const recordIds = ymeta.get('recordIds') as Y.Array<string>;
		doc.transact(() => recordIds.push([a.id]));
		expect(recordIds.toArray().filter((id) => id === a.id)).toHaveLength(2);

		deleteRecord(doc, a.id);

		expect(recordIds.toArray()).not.toContain(a.id);
		expect(ids(doc, document.id)).toEqual([b.id, c.id, d.id]);
	});

	it('reorderRecord cleans up a pre-existing duplicate and still produces a visible move (not just deleteRecord)', () => {
		const { doc, document, a, b, c, d } = setup();
		// Same leftover-duplicate state as the concurrent-move scenario above,
		// but this time a *second* reorderRecord call comes in before anything
		// cleans it up — the array still holds two entries for `a` when this
		// move is requested.
		const ymeta = doc.getMap('documents').get(document.id) as Y.Map<unknown>;
		const recordIds = ymeta.get('recordIds') as Y.Array<string>;
		doc.transact(() => recordIds.insert(2, [a.id])); // ids: a, b, a, c, d
		expect(recordIds.toArray().filter((id) => id === a.id)).toHaveLength(2);

		reorderRecord(doc, a.id, d.id); // move `a` to the very end

		expect(recordIds.toArray().filter((id) => id === a.id)).toHaveLength(1);
		expect(ids(doc, document.id)).toEqual([b.id, c.id, d.id, a.id]);
	});

	it('listRecordsForParent dedupes a duplicate id, keeping the first occurrence', () => {
		const { doc, document, a, b } = setup();
		const ymeta = doc.getMap('documents').get(document.id) as Y.Map<unknown>;
		const recordIds = ymeta.get('recordIds') as Y.Array<string>;
		doc.transact(() => recordIds.insert(1, [a.id])); // duplicate `a` right after its own slot

		const result = ids(doc, document.id);
		expect(result.filter((id) => id === a.id)).toHaveLength(1);
		expect(result.indexOf(a.id)).toBeLessThan(result.indexOf(b.id));
	});

	it('two replicas concurrently moving the same block converge to a single, deduped position with no content loss', () => {
		const { doc: docA, document, a, b, c, d } = setup();
		const docB = new Y.Doc();
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

		const ytextOnA = getRecordYText(docA, a.id)!;
		docA.transact(() => ytextOnA.insert(0, 'from A'));

		// Both replicas independently move the same block (`a`) to a different
		// position before either has seen the other's change.
		reorderRecord(docA, a.id, b.id); // A wants: b, a, c, d
		reorderRecord(docB, a.id, c.id); // B wants: b, c, a, d

		const updateFromA = Y.encodeStateAsUpdate(docA);
		const updateFromB = Y.encodeStateAsUpdate(docB);
		Y.applyUpdate(docB, updateFromA);
		Y.applyUpdate(docA, updateFromB);

		const resultA = ids(docA, document.id);
		const resultB = ids(docB, document.id);
		// Deterministic convergence: whatever position wins, both replicas agree.
		expect(resultA).toEqual(resultB);
		// No duplication and no lost siblings.
		expect(resultA.filter((id) => id === a.id)).toHaveLength(1);
		expect(new Set(resultA)).toEqual(new Set([a.id, b.id, c.id, d.id]));
		// Neither actor's content edit was lost.
		expect(
			yTextToRichText(getRecordYText(docA, a.id)!)
				.runs.map((r) => r.text)
				.join('')
		).toBe('from A');
	});
});

describe('copyDocumentVerbatim / copyCollectionVerbatim: cross-doc migration primitives (#114/#132)', () => {
	it('copies a Document and its blocks into a different Y.Doc, preserving id, order, rich text formatting, and attribution exactly', () => {
		const source = new Y.Doc();
		const target = new Y.Doc();

		const document = createDocument(source, { title: 'Migrated Doc' });
		const record = createRecord(source, { parentId: document.id, blockType: 'heading_1' }, human);
		updateRecordContent(
			source,
			record.id,
			{ runs: [{ text: 'Bold text', marks: { bold: true } }] },
			agent
		);

		copyDocumentVerbatim(source, target, document.id);

		const copiedMeta = getDocument(target, document.id);
		expect(copiedMeta?.title).toBe('Migrated Doc');
		expect(copiedMeta?.order).toBe(document.order);
		expect(copiedMeta?.recordIds).toEqual([record.id]);

		const copiedRecord = getRecord(target, record.id);
		expect(copiedRecord?.blockType).toBe('heading_1');
		expect(copiedRecord?.content).toEqual({ runs: [{ text: 'Bold text', marks: { bold: true } }] });
		expect(copiedRecord?.createdBy).toEqual(human);
		expect(copiedRecord?.lastEditedBy).toEqual(agent);

		// The source doc is untouched — a copy, not a move.
		expect(getDocument(source, document.id)?.title).toBe('Migrated Doc');
		expect(getRecord(source, record.id)).toBeDefined();
	});

	it('copies a Collection and its rows into a different Y.Doc, preserving schema and property values exactly', () => {
		const source = new Y.Doc();
		const target = new Y.Doc();

		const collection = createCollection(source, {
			title: 'Migrated Table',
			schema: [{ key: 'status', label: 'Status', type: 'checkbox' }]
		});
		const row = createRecord(
			source,
			{ parentId: collection.id, properties: { status: { type: 'checkbox', value: true } } },
			human
		);

		copyCollectionVerbatim(source, target, collection.id);

		const copiedMeta = getCollection(target, collection.id);
		expect(copiedMeta?.title).toBe('Migrated Table');
		expect(copiedMeta?.schema).toEqual(collection.schema);
		expect(copiedMeta?.recordIds).toEqual([row.id]);

		const copiedRow = getRecord(target, row.id);
		expect(copiedRow?.properties?.status).toEqual({ type: 'checkbox', value: true });
	});
});

describe('buildDocumentTree: dangling parent references', () => {
	it('treats a document whose parentDocumentId points nowhere as a root', () => {
		const orphan = {
			id: 'orphan',
			title: 'Orphan',
			parentDocumentId: 'does-not-exist',
			order: 'a0',
			recordIds: []
		};
		const tree = buildDocumentTree([orphan]);
		expect(tree).toHaveLength(1);
		expect(tree[0].id).toBe('orphan');
		expect(tree[0].level).toBe(0);
	});
});

describe('readDocumentMeta: tolerates missing optional fields', () => {
	it('falls back to "Untitled" when a document has no title set', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Has a title' });
		const ymeta = (doc.getMap('documents') as Y.Map<Y.Map<unknown>>).get(document.id)!;
		ymeta.delete('title');
		expect(getDocument(doc, document.id)?.title).toBe('Untitled');
	});
});
