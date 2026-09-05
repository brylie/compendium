import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
	buildDocumentTree,
	createDocument,
	deleteDocument,
	getDocument,
	listDocuments,
	resolveChildPages,
	updateDocumentParent,
	updateDocumentTitle
} from './document-ops';
import { createRecord, getRecord, setRecordChildPagesConfig } from './record-ops';
import { NotFoundError, ValidationError } from './errors';
import { type ActorId } from './types';

const human: ActorId = { kind: 'human', userId: 'brylie' };

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

describe('resolveChildPages (issue #43)', () => {
	it('lists only immediate children at the default depth (1)', () => {
		const doc = new Y.Doc();
		const root = createDocument(doc, { title: 'Root' });
		const child1 = createDocument(doc, { title: 'Child 1', parentDocumentId: root.id });
		const child2 = createDocument(doc, {
			title: 'Child 2',
			parentDocumentId: root.id,
			afterDocumentId: child1.id
		});
		createDocument(doc, { title: 'Grandchild', parentDocumentId: child1.id });

		const result = resolveChildPages(listDocuments(doc), root.id, 1);
		expect(result.map((n) => n.id)).toEqual([child1.id, child2.id]);
		expect(result[0].children).toEqual([]);
	});

	it('includes N levels of nesting for a numeric depth', () => {
		const doc = new Y.Doc();
		const root = createDocument(doc, { title: 'Root' });
		const child = createDocument(doc, { title: 'Child', parentDocumentId: root.id });
		const grandchild = createDocument(doc, {
			title: 'Grandchild',
			parentDocumentId: child.id
		});
		createDocument(doc, { title: 'Great-grandchild', parentDocumentId: grandchild.id });

		const result = resolveChildPages(listDocuments(doc), root.id, 2);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe(child.id);
		expect(result[0].children).toHaveLength(1);
		expect(result[0].children[0].id).toBe(grandchild.id);
		expect(result[0].children[0].children).toEqual([]);
	});

	it('walks the whole subtree for depth "unlimited"', () => {
		const doc = new Y.Doc();
		const root = createDocument(doc, { title: 'Root' });
		const child = createDocument(doc, { title: 'Child', parentDocumentId: root.id });
		const grandchild = createDocument(doc, {
			title: 'Grandchild',
			parentDocumentId: child.id
		});
		const greatGrandchild = createDocument(doc, {
			title: 'Great-grandchild',
			parentDocumentId: grandchild.id
		});

		const result = resolveChildPages(listDocuments(doc), root.id, 'unlimited');
		expect(result[0].children[0].children[0].id).toBe(greatGrandchild.id);
	});

	it('returns an empty list for a target with no children', () => {
		const doc = new Y.Doc();
		const root = createDocument(doc, { title: 'Root' });
		expect(resolveChildPages(listDocuments(doc), root.id, 1)).toEqual([]);
	});

	it('returns an empty list when the target id is not present in the given documents at all', () => {
		const doc = new Y.Doc();
		createDocument(doc, { title: 'Unrelated' });
		expect(resolveChildPages(listDocuments(doc), 'missing-id', 1)).toEqual([]);
	});
});

describe('setRecordChildPagesConfig (issue #43)', () => {
	it('sets and independently clears the target and depth, defaulting back to undefined', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const other = createDocument(doc, { title: 'Other' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'child_pages' }, human);
		expect(getRecord(doc, block.id)?.referencedRecordId).toBeUndefined();
		expect(getRecord(doc, block.id)?.childPagesDepth).toBeUndefined();

		setRecordChildPagesConfig(doc, block.id, { referencedRecordId: other.id, depth: 3 }, human);
		expect(getRecord(doc, block.id)?.referencedRecordId).toBe(other.id);
		expect(getRecord(doc, block.id)?.childPagesDepth).toBe(3);

		setRecordChildPagesConfig(doc, block.id, { depth: 'unlimited' }, human);
		expect(getRecord(doc, block.id)?.referencedRecordId).toBe(other.id);
		expect(getRecord(doc, block.id)?.childPagesDepth).toBe('unlimited');

		setRecordChildPagesConfig(doc, block.id, { referencedRecordId: null, depth: null }, human);
		expect(getRecord(doc, block.id)?.referencedRecordId).toBeUndefined();
		expect(getRecord(doc, block.id)?.childPagesDepth).toBeUndefined();
	});

	it('throws NotFoundError for an unknown record', () => {
		const doc = new Y.Doc();
		expect(() => setRecordChildPagesConfig(doc, 'missing', { depth: 2 }, human)).toThrow(
			NotFoundError
		);
	});

	it('rejects reconfiguring a record that is not a child_pages block, leaving it untouched', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const target = createDocument(doc, { title: 'Target' });
		const link = createRecord(
			doc,
			{ parentId: document.id, blockType: 'page_link', referencedRecordId: target.id },
			human
		);

		expect(() =>
			setRecordChildPagesConfig(doc, link.id, { referencedRecordId: document.id }, human)
		).toThrow(ValidationError);
		expect(getRecord(doc, link.id)?.referencedRecordId).toBe(target.id);
	});

	it('rejects a depth that is not a positive safe integer or "unlimited"', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'child_pages' }, human);

		for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => setRecordChildPagesConfig(doc, block.id, { depth: invalid }, human)).toThrow(
				ValidationError
			);
		}
		expect(getRecord(doc, block.id)?.childPagesDepth).toBeUndefined();
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
