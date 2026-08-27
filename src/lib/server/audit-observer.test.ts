import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
	createRecord as crdtCreateRecord,
	createDocument as crdtCreateDocument
} from '$lib/data/records';
import { queryAuditLog } from './audit';
import {
	attachDocAuditObserver,
	flushPendingAuditEvents,
	pendingTimerDocCountForTests,
	resetAuditObserverForTests
} from './audit-observer';
import type { ActorId } from '$lib/data/types';

const human: ActorId = { kind: 'human', userId: 'local' };

function recentActions(targetRecordId: string): string[] {
	return queryAuditLog()
		.filter((a) => a.targetRecordId === targetRecordId)
		.map((a) => a.action);
}

describe('audit-observer: generic UI-mutation audit trail', () => {
	let doc: Y.Doc;

	beforeEach(() => {
		doc = new Y.Doc();
		attachDocAuditObserver(doc);
	});

	afterEach(() => {
		resetAuditObserverForTests();
		doc.destroy();
	});

	it('logs create_record for a client-origin transaction that adds a top-level record entry', () => {
		doc.transact(() => {
			doc.getMap('records').set('r1', new Y.Map());
		}, 'fake-ws-connection');

		expect(recentActions('r1')).toContain('create_record');
	});

	it('does not log anything for a null-origin (service-layer-style) transaction', () => {
		doc.transact(() => {
			doc.getMap('records').set('r-service', new Y.Map());
		});

		expect(recentActions('r-service')).toHaveLength(0);
	});

	it('logs delete_record for a client-origin transaction that removes a top-level record entry', () => {
		doc.transact(() => {
			doc.getMap('records').set('r2', new Y.Map());
		}, 'fake-ws-connection');

		doc.transact(() => {
			doc.getMap('records').delete('r2');
		}, 'fake-ws-connection');

		// queryAuditLog orders newest-first.
		expect(recentActions('r2')).toEqual(['delete_record', 'create_record']);
	});

	it('logs create_document and delete_document for whole-entry changes on the documents map', () => {
		doc.transact(() => {
			doc.getMap('documents').set('d1', new Y.Map());
		}, 'fake-ws-connection');
		expect(recentActions('d1')).toContain('create_document');

		doc.transact(() => {
			doc.getMap('documents').delete('d1');
		}, 'fake-ws-connection');
		expect(recentActions('d1')).toContain('delete_document');
	});

	it('logs create_collection and delete_collection for whole-entry changes on the collections map', () => {
		doc.transact(() => {
			doc.getMap('collections').set('c1', new Y.Map());
		}, 'fake-ws-connection');
		expect(recentActions('c1')).toContain('create_collection');

		doc.transact(() => {
			doc.getMap('collections').delete('c1');
		}, 'fake-ws-connection');
		expect(recentActions('c1')).toContain('delete_collection');
	});

	describe('update coalescing (debounced, immediate flush available)', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('coalesces rapid nested edits to the same record into exactly one debounced update_record row', () => {
			const record = crdtCreateRecord(
				doc,
				{ parentId: makeDoc(doc), blockType: 'paragraph' },
				human
			);
			const yrecord = doc.getMap('records').get(record.id) as Y.Map<unknown>;
			const content = yrecord.get('content') as Y.Text;

			doc.transact(() => content.insert(0, 'a'), 'fake-ws-connection');
			vi.advanceTimersByTime(1_000);
			doc.transact(() => content.insert(1, 'b'), 'fake-ws-connection');
			vi.advanceTimersByTime(1_000);
			doc.transact(() => content.insert(2, 'c'), 'fake-ws-connection');

			// Still inside the debounce window from the most recent edit.
			expect(recentActions(record.id).filter((a) => a === 'update_record')).toHaveLength(0);

			vi.advanceTimersByTime(3_000);
			expect(recentActions(record.id).filter((a) => a === 'update_record')).toHaveLength(1);
		});

		it('logs exactly one update_record when a content edit and a field edit land in the same transaction', () => {
			const record = crdtCreateRecord(
				doc,
				{ parentId: makeDoc(doc), blockType: 'paragraph' },
				human
			);
			const yrecord = doc.getMap('records').get(record.id) as Y.Map<unknown>;
			const content = yrecord.get('content') as Y.Text;

			doc.transact(() => {
				content.insert(0, 'hello');
				yrecord.set('checked', true);
			}, 'fake-ws-connection');

			vi.advanceTimersByTime(3_000);
			expect(recentActions(record.id).filter((a) => a === 'update_record')).toHaveLength(1);
		});

		it('flushPendingAuditEvents writes a pending debounced update immediately', () => {
			const record = crdtCreateRecord(
				doc,
				{ parentId: makeDoc(doc), blockType: 'paragraph' },
				human
			);
			const yrecord = doc.getMap('records').get(record.id) as Y.Map<unknown>;
			const content = yrecord.get('content') as Y.Text;

			doc.transact(() => content.insert(0, 'x'), 'fake-ws-connection');
			expect(recentActions(record.id).filter((a) => a === 'update_record')).toHaveLength(0);

			flushPendingAuditEvents();
			expect(recentActions(record.id).filter((a) => a === 'update_record')).toHaveLength(1);
		});

		it('preserves update-before-delete ordering when a record is deleted within its edit’s debounce window', () => {
			const record = crdtCreateRecord(
				doc,
				{ parentId: makeDoc(doc), blockType: 'paragraph' },
				human
			);
			const yrecord = doc.getMap('records').get(record.id) as Y.Map<unknown>;
			const content = yrecord.get('content') as Y.Text;

			// Edit, then delete moments later — still well inside the 3s debounce
			// window, so the update event is still only pending, not yet written.
			doc.transact(() => content.insert(0, 'edited just before deletion'), 'fake-ws-connection');
			vi.advanceTimersByTime(500);
			doc.transact(() => {
				doc.getMap('records').delete(record.id);
			}, 'fake-ws-connection');

			// Without the fix, the pending update wouldn't surface until the full
			// debounce window elapses — after the delete already logged — putting
			// update_record after delete_record for the same, now-deleted target.
			const actions = recentActions(record.id);
			expect(actions.filter((a) => a === 'update_record')).toHaveLength(1);
			expect(actions.filter((a) => a === 'delete_record')).toHaveLength(1);
			// queryAuditLog orders newest-first, so delete (written second, right
			// after the flush) appears before update (written first, by the flush).
			expect(actions.indexOf('delete_record')).toBeLessThan(actions.indexOf('update_record'));

			// The debounce timer must actually be gone, not just already fired —
			// letting the full window elapse must not log a second update_record.
			vi.advanceTimersByTime(3_000);
			expect(recentActions(record.id).filter((a) => a === 'update_record')).toHaveLength(1);
		});

		it("debounces a same-id record independently per Y.Doc, so one workspace does not clobber another's pending update", () => {
			// Two independently-resolved workspace contexts (workspace-store.ts)
			// can each contain a record sharing the same id — record ids are only
			// unique within their own doc. A debounce keyed on `${kind}:${id}`
			// alone, shared across every attached doc, would let doc B's edit
			// clear/overwrite doc A's still-pending timer for the "same" key.
			const docB = new Y.Doc();
			attachDocAuditObserver(docB);

			try {
				const sharedId = 'shared-record-id';
				const parentA = makeDoc(doc);
				const parentB = makeDoc(docB);
				crdtCreateRecord(doc, { id: sharedId, parentId: parentA, blockType: 'paragraph' }, human);
				crdtCreateRecord(docB, { id: sharedId, parentId: parentB, blockType: 'paragraph' }, human);

				const yrecordA = doc.getMap('records').get(sharedId) as Y.Map<unknown>;
				const yrecordB = docB.getMap('records').get(sharedId) as Y.Map<unknown>;

				doc.transact(() => (yrecordA.get('content') as Y.Text).insert(0, 'from A'), 'ws-a');
				vi.advanceTimersByTime(1_000);
				// Doc B's edit for the same record id arrives inside doc A's
				// debounce window. Without per-doc scoping this would reset/steal
				// the timer keyed by "record:shared-record-id".
				docB.transact(() => (yrecordB.get('content') as Y.Text).insert(0, 'from B'), 'ws-b');

				vi.advanceTimersByTime(3_000);
				// Both docs' pending updates must have fired on their own schedule —
				// neither cleared the other's timer.
				expect(recentActions(sharedId).filter((a) => a === 'update_record').length).toBe(2);
			} finally {
				docB.destroy();
			}
		});

		it('flushes a pending update for a record id containing a colon without truncating it', () => {
			// A `${kind}:${id}` key split back apart on ':' would misparse an id
			// that itself contains a colon (recordId has no format restriction —
			// see the MCP server's `recordId: z.string()`), truncating it and
			// causing flushPendingAuditEvents to look up the wrong/nonexistent key.
			const colonId = 'my:id';
			const record = crdtCreateRecord(
				doc,
				{ id: colonId, parentId: makeDoc(doc), blockType: 'paragraph' },
				human
			);
			const yrecord = doc.getMap('records').get(record.id) as Y.Map<unknown>;
			const content = yrecord.get('content') as Y.Text;

			doc.transact(() => content.insert(0, 'x'), 'fake-ws-connection');
			expect(recentActions(colonId).filter((a) => a === 'update_record')).toHaveLength(0);

			flushPendingAuditEvents();
			expect(recentActions(colonId).filter((a) => a === 'update_record')).toHaveLength(1);
		});

		it("prunes a doc's entry once its last pending timer fires, instead of retaining an empty inner map forever", () => {
			const record = crdtCreateRecord(
				doc,
				{ parentId: makeDoc(doc), blockType: 'paragraph' },
				human
			);
			const yrecord = doc.getMap('records').get(record.id) as Y.Map<unknown>;
			const content = yrecord.get('content') as Y.Text;

			doc.transact(() => content.insert(0, 'x'), 'fake-ws-connection');
			expect(pendingTimerDocCountForTests()).toBe(1);

			vi.advanceTimersByTime(3_000);
			expect(pendingTimerDocCountForTests()).toBe(0);
		});

		it("prunes a doc's entry on an explicit flush too, not just on natural timer expiry", () => {
			const record = crdtCreateRecord(
				doc,
				{ parentId: makeDoc(doc), blockType: 'paragraph' },
				human
			);
			const yrecord = doc.getMap('records').get(record.id) as Y.Map<unknown>;
			const content = yrecord.get('content') as Y.Text;

			doc.transact(() => content.insert(0, 'x'), 'fake-ws-connection');
			expect(pendingTimerDocCountForTests()).toBe(1);

			flushPendingAuditEvents();
			expect(pendingTimerDocCountForTests()).toBe(0);
		});

		it('logs update_document when a document’s recordIds order changes without touching its own record', () => {
			const documentId = makeDoc(doc);
			const a = crdtCreateRecord(doc, { parentId: documentId, blockType: 'paragraph' }, human);
			crdtCreateRecord(doc, { parentId: documentId, blockType: 'paragraph' }, human);

			const ymeta = doc.getMap('documents').get(documentId) as Y.Map<unknown>;
			const recordIds = ymeta.get('recordIds') as Y.Array<string>;

			doc.transact(() => {
				const ids = recordIds.toArray();
				recordIds.delete(0, ids.length);
				recordIds.insert(0, [...ids].reverse());
			}, 'fake-ws-connection');

			vi.advanceTimersByTime(3_000);
			expect(recentActions(documentId).filter((a) => a === 'update_document')).toHaveLength(1);
			// The reorder alone shouldn't be misattributed to either record.
			expect(recentActions(a.id).filter((act) => act === 'update_record')).toHaveLength(0);
		});
	});
});

/** Creates a bare Document meta entry directly (no service layer, no audit) as a parent for record tests. */
function makeDoc(doc: Y.Doc): string {
	const created = crdtCreateDocument(doc, { title: 'Parent' });
	return created.id;
}
