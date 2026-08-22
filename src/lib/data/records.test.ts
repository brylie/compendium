import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
	createCollection,
	createDocument,
	createRecord,
	deleteRecord,
	getRecord,
	listCollections,
	listDocuments,
	listRecordsForParent,
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

describe('records: CRDT merge acceptance criteria', () => {
	it('merges concurrent overlapping bold/italic formatting with no corrupted or lost marks', () => {
		// Two replicas of the same workspace, simulating two humans editing offline
		// then syncing — the PRD's acceptance criterion for the rich-text model.
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
