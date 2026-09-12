import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createDocument as crdtCreateDocument } from '$lib/data/document-ops';
import { createCollection as crdtCreateCollection } from '$lib/data/collection-ops';
import {
	createColumnsBlock as crdtCreateColumnsBlock,
	createRecord as crdtCreateRecord,
	deleteRecord as crdtDeleteRecord,
	getRecordYText,
	moveRecordToParent as crdtMoveRecordToParent
} from '$lib/data/record-ops';
import {
	deleteRecordIndexEntry,
	rebuildRecordIndexForShard,
	searchRecordIndex,
	upsertRecordIndexEntry
} from './record-index';
import {
	attachRecordIndexObserver,
	resetRecordIndexObserverForTests
} from './record-index-observer';
import {
	LOCAL_UI_ORIGIN,
	SERVICE_ORIGIN,
	transactWithOrigin,
	UnknownMutationOriginError
} from '../mutation-origin';
import type { ActorId } from '$lib/data/types';

const WS = 'default';
const SHARD = 'default';
const actor: ActorId = { kind: 'human', userId: 'brylie' };

function seedDocument(doc: Y.Doc, title = 'Doc') {
	return transactWithOrigin(doc, SERVICE_ORIGIN, () => crdtCreateDocument(doc, { title }));
}

function seedCollection(doc: Y.Doc, title = 'Collection') {
	return transactWithOrigin(doc, SERVICE_ORIGIN, () =>
		crdtCreateCollection(doc, { title, schema: [] })
	);
}

describe('record-index: rebuilding from Y.Doc state', () => {
	let doc: Y.Doc;

	beforeEach(() => {
		doc = new Y.Doc();
	});

	afterEach(() => {
		doc.destroy();
	});

	it('indexes a Document block’s content', () => {
		const document = seedDocument(doc);
		const block = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			crdtCreateRecord(doc, { parentId: document.id, blockType: 'paragraph' }, actor)
		);
		transactWithOrigin(doc, SERVICE_ORIGIN, () => {
			getRecordYText(doc, block.id)!.insert(0, 'hello workspace');
		});

		rebuildRecordIndexForShard(WS, SHARD, doc);

		const hits = searchRecordIndex(WS, 'workspace');
		expect(hits).toEqual([expect.objectContaining({ recordId: block.id, parentId: document.id })]);
	});

	it('indexes a Collection row’s text/select properties but not other property types', () => {
		const collection = seedCollection(doc);
		const row = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			crdtCreateRecord(
				doc,
				{
					parentId: collection.id,
					properties: {
						priority: { type: 'number', value: 3 },
						status: { type: 'select', value: 'blocked-alpha' }
					}
				},
				actor
			)
		);

		rebuildRecordIndexForShard(WS, SHARD, doc);

		expect(searchRecordIndex(WS, 'alpha').some((h) => h.recordId === row.id)).toBe(true);
		expect(searchRecordIndex(WS, '3').some((h) => h.recordId === row.id)).toBe(false);
	});

	it('resolves a nested container record’s child to its owning Document, not the container', () => {
		const document = seedDocument(doc);
		const columns = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			crdtCreateColumnsBlock(doc, { parentId: document.id }, actor)
		);
		const column = columns.childRecordIds![0];
		const paragraph = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			crdtCreateRecord(doc, { parentId: column, blockType: 'paragraph' }, actor)
		);
		transactWithOrigin(doc, SERVICE_ORIGIN, () => {
			getRecordYText(doc, paragraph.id)!.insert(0, 'nested column text');
		});

		rebuildRecordIndexForShard(WS, SHARD, doc);

		const hits = searchRecordIndex(WS, 'nested');
		expect(hits).toEqual([
			expect.objectContaining({ recordId: paragraph.id, parentId: document.id })
		]);
	});

	it('removes rows for records no longer present in the Y.Doc', () => {
		const document = seedDocument(doc);
		const block = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			crdtCreateRecord(doc, { parentId: document.id, blockType: 'paragraph' }, actor)
		);
		transactWithOrigin(doc, SERVICE_ORIGIN, () => {
			getRecordYText(doc, block.id)!.insert(0, 'disappearing');
		});
		rebuildRecordIndexForShard(WS, SHARD, doc);
		expect(searchRecordIndex(WS, 'disappearing')).toHaveLength(1);

		transactWithOrigin(doc, SERVICE_ORIGIN, () => crdtDeleteRecord(doc, block.id));
		rebuildRecordIndexForShard(WS, SHARD, doc);

		expect(searchRecordIndex(WS, 'disappearing')).toHaveLength(0);
	});

	it('scopes results to the requested workspace', () => {
		const document = seedDocument(doc);
		const block = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			crdtCreateRecord(doc, { parentId: document.id, blockType: 'paragraph' }, actor)
		);
		transactWithOrigin(doc, SERVICE_ORIGIN, () => {
			getRecordYText(doc, block.id)!.insert(0, 'workspace-scoped');
		});
		rebuildRecordIndexForShard(WS, SHARD, doc);

		expect(searchRecordIndex('a-different-workspace', 'workspace-scoped')).toHaveLength(0);
		expect(searchRecordIndex(WS, 'workspace-scoped')).toHaveLength(1);
	});

	it('matches everything in the workspace on a blank query, mirroring the prior substring scan’s "".includes(x) behavior', () => {
		const document = seedDocument(doc);
		const block = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			crdtCreateRecord(doc, { parentId: document.id, blockType: 'paragraph' }, actor)
		);
		transactWithOrigin(doc, SERVICE_ORIGIN, () => {
			getRecordYText(doc, block.id)!.insert(0, 'anything');
		});
		rebuildRecordIndexForShard(WS, SHARD, doc);

		expect(searchRecordIndex(WS, '   ').some((h) => h.recordId === block.id)).toBe(true);
	});
});

describe('record-index: upsert/delete primitives', () => {
	let doc: Y.Doc;

	beforeEach(() => {
		doc = new Y.Doc();
	});

	afterEach(() => {
		doc.destroy();
	});

	it('clears a stale row when the record no longer exists', () => {
		const document = seedDocument(doc);
		const block = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			crdtCreateRecord(doc, { parentId: document.id, blockType: 'paragraph' }, actor)
		);
		transactWithOrigin(doc, SERVICE_ORIGIN, () => {
			getRecordYText(doc, block.id)!.insert(0, 'will be deleted');
		});
		upsertRecordIndexEntry(WS, SHARD, doc, block.id);
		expect(searchRecordIndex(WS, 'deleted')).toHaveLength(1);

		transactWithOrigin(doc, SERVICE_ORIGIN, () => crdtDeleteRecord(doc, block.id));
		upsertRecordIndexEntry(WS, SHARD, doc, block.id);

		expect(searchRecordIndex(WS, 'deleted')).toHaveLength(0);
	});

	it('deleteRecordIndexEntry is a no-op when no row exists for the id', () => {
		expect(() => deleteRecordIndexEntry('never-indexed')).not.toThrow();
	});
});

describe('record-index-observer: keeping record_index live for one resolved shard', () => {
	let doc: Y.Doc;

	beforeEach(() => {
		doc = new Y.Doc();
		attachRecordIndexObserver(WS, SHARD, doc);
	});

	afterEach(() => {
		resetRecordIndexObserverForTests();
		doc.destroy();
	});

	it('indexes a record created through a direct (non-service) UI-origin transaction', () => {
		const document = seedDocument(doc);
		let recordId = '';
		doc.transact(() => {
			const record = crdtCreateRecord(
				doc,
				{ parentId: document.id, blockType: 'paragraph' },
				actor
			);
			recordId = record.id;
			getRecordYText(doc, record.id)!.insert(0, 'typed live');
		}, LOCAL_UI_ORIGIN);

		expect(searchRecordIndex(WS, 'live').some((h) => h.recordId === recordId)).toBe(true);
	});

	it('re-indexes a record’s content as its Y.Text changes', () => {
		const document = seedDocument(doc);
		const record = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			crdtCreateRecord(doc, { parentId: document.id, blockType: 'paragraph' }, actor)
		);

		transactWithOrigin(doc, LOCAL_UI_ORIGIN, () => {
			getRecordYText(doc, record.id)!.insert(0, 'first draft');
		});
		expect(searchRecordIndex(WS, 'first').some((h) => h.recordId === record.id)).toBe(true);

		transactWithOrigin(doc, LOCAL_UI_ORIGIN, () => {
			getRecordYText(doc, record.id)!.delete(0, 'first draft'.length);
			getRecordYText(doc, record.id)!.insert(0, 'revised text');
		});
		expect(searchRecordIndex(WS, 'first').some((h) => h.recordId === record.id)).toBe(false);
		expect(searchRecordIndex(WS, 'revised').some((h) => h.recordId === record.id)).toBe(true);
	});

	it('removes a record’s row the moment it’s deleted', () => {
		const document = seedDocument(doc);
		const record = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			crdtCreateRecord(doc, { parentId: document.id, blockType: 'paragraph' }, actor)
		);
		transactWithOrigin(doc, LOCAL_UI_ORIGIN, () => {
			getRecordYText(doc, record.id)!.insert(0, 'to be removed');
		});
		expect(searchRecordIndex(WS, 'removed')).toHaveLength(1);

		transactWithOrigin(doc, LOCAL_UI_ORIGIN, () => crdtDeleteRecord(doc, record.id));

		expect(searchRecordIndex(WS, 'removed')).toHaveLength(0);
	});

	it('re-resolves a moved record’s owning parent id', () => {
		const source = seedDocument(doc, 'Source');
		const destination = seedDocument(doc, 'Destination');
		const record = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			crdtCreateRecord(doc, { parentId: source.id, blockType: 'paragraph' }, actor)
		);
		transactWithOrigin(doc, LOCAL_UI_ORIGIN, () => {
			getRecordYText(doc, record.id)!.insert(0, 'movable content');
		});
		expect(searchRecordIndex(WS, 'movable').find((h) => h.recordId === record.id)?.parentId).toBe(
			source.id
		);

		transactWithOrigin(doc, LOCAL_UI_ORIGIN, () =>
			crdtMoveRecordToParent(doc, record.id, destination.id)
		);

		expect(searchRecordIndex(WS, 'movable').find((h) => h.recordId === record.id)?.parentId).toBe(
			destination.id
		);
	});

	it('rejects an unregistered mutation origin, even one with a recognized source name', () => {
		expect(() =>
			doc.transact(() => doc.getMap('records').set('bad', new Y.Map()), { source: 'service' })
		).toThrow(UnknownMutationOriginError);
	});
});
