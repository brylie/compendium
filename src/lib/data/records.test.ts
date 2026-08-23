import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
	buildDocumentTree,
	createCollection,
	createDocument,
	createRecord,
	deleteCollection,
	deleteDocument,
	deleteRecord,
	getCollection,
	getDocument,
	getRecord,
	getRecordYText,
	listCollections,
	listDocuments,
	listRecordsForParent,
	NotFoundError,
	setBlockType,
	setRecordChecked,
	setRecordCollapsed,
	setRecordReferencedId,
	touchRecordEditor,
	updateCollectionSchema,
	updateCollectionTitle,
	updateDocumentParent,
	updateDocumentTitle,
	updateRecordContent,
	updateRecordProperties
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
		expect(() => updateDocumentParent(doc, 'missing', undefined)).toThrow(NotFoundError);
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

		updateDocumentParent(doc, child.id, undefined);
		expect(getDocument(doc, child.id)?.parentDocumentId).toBeUndefined();
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
