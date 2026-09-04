import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
	createRecord as rawCreateRecord,
	createDocument as crdtCreateDocument,
	reorderRecord as crdtReorderRecord
} from '$lib/data/records';
import { queryAuditLog } from './audit';
import {
	attachDocAuditObserver,
	flushPendingAuditEvents,
	pendingTimerDocCountForTests,
	resetAuditObserverForTests
} from './audit-observer';
import type { ActorId } from '$lib/data/types';
import { remoteUiOrigin, SERVICE_ORIGIN, transactWithOrigin } from '../mutation-origin';

const human: ActorId = { kind: 'human', userId: 'local' };
const REMOTE_UI_ORIGIN = remoteUiOrigin('audit-observer-test');

function crdtCreateRecord(...args: Parameters<typeof rawCreateRecord>) {
	return transactWithOrigin(args[0], SERVICE_ORIGIN, () => rawCreateRecord(...args));
}

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
		}, REMOTE_UI_ORIGIN);

		expect(recentActions('r1')).toContain('create_record');
	});

	it('does not log anything for a named service transaction', () => {
		doc.transact(() => {
			doc.getMap('records').set('r-service', new Y.Map());
		}, SERVICE_ORIGIN);

		expect(recentActions('r-service')).toHaveLength(0);
	});

	it('logs delete_record for a client-origin transaction that removes a top-level record entry', () => {
		doc.transact(() => {
			doc.getMap('records').set('r2', new Y.Map());
		}, REMOTE_UI_ORIGIN);

		doc.transact(() => {
			doc.getMap('records').delete('r2');
		}, REMOTE_UI_ORIGIN);

		// queryAuditLog orders newest-first.
		expect(recentActions('r2')).toEqual(['delete_record', 'create_record']);
	});

	it('logs create_document and delete_document for whole-entry changes on the documents map', () => {
		doc.transact(() => {
			doc.getMap('documents').set('d1', new Y.Map());
		}, REMOTE_UI_ORIGIN);
		expect(recentActions('d1')).toContain('create_document');

		doc.transact(() => {
			doc.getMap('documents').delete('d1');
		}, REMOTE_UI_ORIGIN);
		expect(recentActions('d1')).toContain('delete_document');
	});

	it('logs create_collection and delete_collection for whole-entry changes on the collections map', () => {
		doc.transact(() => {
			doc.getMap('collections').set('c1', new Y.Map());
		}, REMOTE_UI_ORIGIN);
		expect(recentActions('c1')).toContain('create_collection');

		doc.transact(() => {
			doc.getMap('collections').delete('c1');
		}, REMOTE_UI_ORIGIN);
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

			doc.transact(() => content.insert(0, 'a'), REMOTE_UI_ORIGIN);
			vi.advanceTimersByTime(1_000);
			doc.transact(() => content.insert(1, 'b'), REMOTE_UI_ORIGIN);
			vi.advanceTimersByTime(1_000);
			doc.transact(() => content.insert(2, 'c'), REMOTE_UI_ORIGIN);

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
			}, REMOTE_UI_ORIGIN);

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

			doc.transact(() => content.insert(0, 'x'), REMOTE_UI_ORIGIN);
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
			doc.transact(() => content.insert(0, 'edited just before deletion'), REMOTE_UI_ORIGIN);
			vi.advanceTimersByTime(500);
			doc.transact(() => {
				doc.getMap('records').delete(record.id);
			}, REMOTE_UI_ORIGIN);

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

				doc.transact(
					() => (yrecordA.get('content') as Y.Text).insert(0, 'from A'),
					remoteUiOrigin('ws-a')
				);
				vi.advanceTimersByTime(1_000);
				// Doc B's edit for the same record id arrives inside doc A's
				// debounce window. Without per-doc scoping this would reset/steal
				// the timer keyed by "record:shared-record-id".
				docB.transact(
					() => (yrecordB.get('content') as Y.Text).insert(0, 'from B'),
					remoteUiOrigin('ws-b')
				);

				vi.advanceTimersByTime(3_000);
				// Both docs' pending updates must have fired on their own schedule —
				// neither cleared the other's timer.
				expect(recentActions(sharedId).filter((a) => a === 'update_record')).toHaveLength(2);
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

			doc.transact(() => content.insert(0, 'x'), REMOTE_UI_ORIGIN);
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

			doc.transact(() => content.insert(0, 'x'), REMOTE_UI_ORIGIN);
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

			doc.transact(() => content.insert(0, 'x'), REMOTE_UI_ORIGIN);
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
			}, REMOTE_UI_ORIGIN);

			vi.advanceTimersByTime(3_000);
			expect(recentActions(documentId).filter((a) => a === 'update_document')).toHaveLength(1);
			// The reorder alone shouldn't be misattributed to either record.
			expect(recentActions(a.id).filter((act) => act === 'update_record')).toHaveLength(0);
		});

		it("logs update_document, not update_record, for BlockEditor's actual drag-and-drop entry point (reorderRecord)", () => {
			const documentId = makeDoc(doc);
			const a = crdtCreateRecord(doc, { parentId: documentId, blockType: 'paragraph' }, human);
			const b = crdtCreateRecord(doc, { parentId: documentId, blockType: 'paragraph' }, human);

			doc.transact(() => crdtReorderRecord(doc, a.id, b.id), REMOTE_UI_ORIGIN);

			vi.advanceTimersByTime(3_000);
			expect(recentActions(documentId).filter((act) => act === 'update_document')).toHaveLength(1);
			expect(recentActions(a.id).filter((act) => act === 'update_record')).toHaveLength(0);
			expect(recentActions(b.id).filter((act) => act === 'update_record')).toHaveLength(0);
		});

		it('does not retain a doc entry that still has another pending timer once one of its timers is pruned', () => {
			const recordA = crdtCreateRecord(
				doc,
				{ parentId: makeDoc(doc), blockType: 'paragraph' },
				human
			);
			const recordB = crdtCreateRecord(
				doc,
				{ parentId: makeDoc(doc), blockType: 'paragraph' },
				human
			);
			const contentA = (doc.getMap('records').get(recordA.id) as Y.Map<unknown>).get(
				'content'
			) as Y.Text;
			const contentB = (doc.getMap('records').get(recordB.id) as Y.Map<unknown>).get(
				'content'
			) as Y.Text;

			doc.transact(() => contentA.insert(0, 'a'), REMOTE_UI_ORIGIN);
			vi.advanceTimersByTime(1_000);
			doc.transact(() => contentB.insert(0, 'b'), REMOTE_UI_ORIGIN);

			// A's timer fires first, alone — B's is still pending for this same
			// doc, so the doc's own entry in pendingUpdateTimers must survive.
			vi.advanceTimersByTime(2_000);
			expect(recentActions(recordA.id)).toContain('update_record');
			expect(pendingTimerDocCountForTests()).toBe(1);

			vi.advanceTimersByTime(1_000);
			expect(recentActions(recordB.id)).toContain('update_record');
			expect(pendingTimerDocCountForTests()).toBe(0);
		});
	});

	it('deleting a record with no prior pending edit logs delete_record without a spurious flush', () => {
		const record = crdtCreateRecord(doc, { parentId: makeDoc(doc), blockType: 'paragraph' }, human);

		doc.transact(() => {
			doc.getMap('records').delete(record.id);
		}, REMOTE_UI_ORIGIN);

		expect(recentActions(record.id)).toEqual(['delete_record']);
	});

	it('deleting a record in the same transaction as a content edit logs only delete_record, no orphaned update', () => {
		const record = crdtCreateRecord(doc, { parentId: makeDoc(doc), blockType: 'paragraph' }, human);
		const yrecord = doc.getMap('records').get(record.id) as Y.Map<unknown>;
		const content = yrecord.get('content') as Y.Text;

		// Editing the content and removing the record's own top-level entry in
		// one transaction means the content Y.Text's owning entry can no longer
		// be resolved (its key is already gone from the records map by the time
		// pass 2 walks the change) — resolveOwningEntry must return undefined
		// for it rather than throwing or misattributing an update.
		doc.transact(() => {
			content.insert(0, 'edited and deleted together');
			doc.getMap('records').delete(record.id);
		}, REMOTE_UI_ORIGIN);

		expect(recentActions(record.id)).toEqual(['delete_record']);
	});
});

/** Creates a bare Document meta entry directly (no service layer, no audit) as a parent for record tests. */
function makeDoc(doc: Y.Doc): string {
	const created = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
		crdtCreateDocument(doc, { title: 'Parent' })
	);
	return created.id;
}
