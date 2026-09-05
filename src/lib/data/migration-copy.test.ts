import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createDocument, getDocument } from './document-ops';
import { createCollection, getCollection } from './collection-ops';
import { createRecord, getRecord, updateRecordContent } from './record-ops';
import { copyCollectionVerbatim, copyDocumentVerbatim } from './migration-copy';
import { type ActorId } from './types';

const human: ActorId = { kind: 'human', userId: 'brylie' };
const agent: ActorId = { kind: 'agent', agentId: 'a1', name: 'Research Agent' };

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
