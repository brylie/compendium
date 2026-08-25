import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
	createCollection,
	createDocument,
	createRecord,
	deleteRecord,
	getDocument,
	getRecord,
	getRecordYText,
	updateRecordProperties
} from '$lib/data/records';
import type { ActorId } from '$lib/data/types';
import { createUndoManager } from './undo';

let singletonDoc: Y.Doc;
vi.mock('./yjs-client', () => ({ getClientDoc: () => singletonDoc }));

// createUndoManager(doc) is exercised directly against real Y.Doc instances
// here, with no mocking of $lib/client/yjs-client — these are the tests that
// prove the actual CRDT-level guarantees the feature is built on (issue #8):
// scoping, grouping, and — the two hardest requirements — that undo never
// reverts another actor's transaction, and redo restores exactly the local
// action even after a remote edit lands in between. The thin singleton
// wrapper (undo(), redo(), subscribeUndoRedoState()) has its own smaller
// suite further down, since that part is just plumbing to getClientDoc().

const HUMAN: ActorId = { kind: 'human', userId: 'local' };
const REMOTE_ACTOR: ActorId = { kind: 'human', userId: 'collaborator' };

/**
 * Applies `sourceDoc`'s current state to `doc` as a single incoming update,
 * with a non-null object identity as the transaction origin — standing in
 * for the WebsocketProvider instance that origin would be on a real client
 * (see undo.ts's module comment). This is the same mechanism a real second
 * browser tab's edit — or an MCP agent's edit relayed through the shared
 * Y.Doc — arrives by, so it's the right way to simulate "a collaborator's
 * intervening work" in a unit test without booting a real server/websocket.
 */
function deliverAsRemoteUpdate(doc: Y.Doc, sourceDoc: Y.Doc): void {
	const update = Y.encodeStateAsUpdate(sourceDoc, Y.encodeStateVector(doc));
	Y.applyUpdate(doc, update, {});
}

describe('createUndoManager: scope', () => {
	let doc: Y.Doc;

	beforeEach(() => {
		doc = new Y.Doc();
	});

	afterEach(() => {
		doc.destroy();
	});

	it('captures local block creation, and undo/redo it removes/restores the block and its position', () => {
		createDocument(doc, { id: 'd1', title: 'Doc' });
		const um = createUndoManager(doc);
		um.stopCapturing();

		const record = createRecord(doc, { parentId: 'd1', blockType: 'paragraph' }, HUMAN);
		expect(getDocument(doc, 'd1')?.recordIds).toEqual([record.id]);
		expect(um.undoStack.length).toBeGreaterThan(0);

		um.undo();
		expect(getRecord(doc, record.id)).toBeUndefined();
		expect(getDocument(doc, 'd1')?.recordIds).toEqual([]);

		um.redo();
		expect(getRecord(doc, record.id)).toBeDefined();
		expect(getDocument(doc, 'd1')?.recordIds).toEqual([record.id]);
	});

	it('captures a Y.Text content edit (a block’s rich text) nested under records', () => {
		createDocument(doc, { id: 'd1', title: 'Doc' });
		const record = createRecord(doc, { parentId: 'd1', blockType: 'paragraph' }, HUMAN);
		const um = createUndoManager(doc);
		um.stopCapturing();

		const ytext = getRecordYText(doc, record.id)!;
		doc.transact(() => ytext.insert(0, 'Hello'));
		expect(ytext.toString()).toBe('Hello');

		um.undo();
		expect(ytext.toString()).toBe('');

		um.redo();
		expect(ytext.toString()).toBe('Hello');
	});

	it('captures record creation at a specific position, and undo/redo preserves sibling order', () => {
		createDocument(doc, { id: 'd1', title: 'Doc' });
		const a = createRecord(doc, { parentId: 'd1', blockType: 'paragraph' }, HUMAN);
		const b = createRecord(doc, { parentId: 'd1', blockType: 'paragraph' }, HUMAN);
		const um = createUndoManager(doc);
		um.stopCapturing();

		const c = createRecord(
			doc,
			{ parentId: 'd1', blockType: 'paragraph', afterRecordId: a.id },
			HUMAN
		);
		expect(getDocument(doc, 'd1')?.recordIds).toEqual([a.id, c.id, b.id]);

		um.undo();
		expect(getDocument(doc, 'd1')?.recordIds).toEqual([a.id, b.id]);

		um.redo();
		expect(getDocument(doc, 'd1')?.recordIds).toEqual([a.id, c.id, b.id]);
	});

	it('captures a block deletion, and undo restores both the record and its array position', () => {
		createDocument(doc, { id: 'd1', title: 'Doc' });
		const a = createRecord(doc, { parentId: 'd1', blockType: 'paragraph' }, HUMAN);
		const b = createRecord(doc, { parentId: 'd1', blockType: 'paragraph' }, HUMAN);
		const um = createUndoManager(doc);
		um.stopCapturing();

		deleteRecord(doc, a.id);
		expect(getDocument(doc, 'd1')?.recordIds).toEqual([b.id]);

		um.undo();
		expect(getDocument(doc, 'd1')?.recordIds).toEqual([a.id, b.id]);
		expect(getRecord(doc, a.id)).toBeDefined();

		um.redo();
		expect(getDocument(doc, 'd1')?.recordIds).toEqual([b.id]);
		expect(getRecord(doc, a.id)).toBeUndefined();
	});

	it('captures a Collection row property edit', () => {
		createCollection(doc, {
			id: 'c1',
			title: 'Table',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		const row = createRecord(
			doc,
			{ parentId: 'c1', properties: { name: { type: 'text', value: 'A' } } },
			HUMAN
		);
		const um = createUndoManager(doc);
		um.stopCapturing();

		updateRecordProperties(doc, row.id, { name: { type: 'text', value: 'B' } }, HUMAN);
		expect(getRecord(doc, row.id)?.properties?.name).toEqual({ type: 'text', value: 'B' });

		um.undo();
		expect(getRecord(doc, row.id)?.properties?.name).toEqual({ type: 'text', value: 'A' });

		um.redo();
		expect(getRecord(doc, row.id)?.properties?.name).toEqual({ type: 'text', value: 'B' });
	});

	it('groups rapid same-burst edits into a single undo step, but keeps stopCapturing()-separated actions distinct', () => {
		createDocument(doc, { id: 'd1', title: 'Doc' });
		const record = createRecord(doc, { parentId: 'd1', blockType: 'paragraph' }, HUMAN);
		const um = createUndoManager(doc);
		um.stopCapturing();
		const ytext = getRecordYText(doc, record.id)!;

		// Same burst (default captureTimeout, no stopCapturing between them) —
		// this is what makes undoing a sentence not require one undo per
		// keystroke, matching every native text editor's convention.
		doc.transact(() => ytext.insert(0, 'a'));
		doc.transact(() => ytext.insert(1, 'b'));
		expect(um.undoStack).toHaveLength(1);

		um.stopCapturing();
		doc.transact(() => ytext.insert(2, 'c'));
		expect(um.undoStack).toHaveLength(2);

		um.undo();
		expect(ytext.toString()).toBe('ab');
		um.undo();
		expect(ytext.toString()).toBe('');
	});
});

describe('createUndoManager: per-actor isolation', () => {
	let doc: Y.Doc;

	beforeEach(() => {
		doc = new Y.Doc();
	});

	afterEach(() => {
		doc.destroy();
	});

	it('never tracks, or reverts, a remote peer’s transaction', () => {
		createDocument(doc, { id: 'd1', title: 'Doc' });
		const um = createUndoManager(doc);

		const remoteDoc = new Y.Doc();
		Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(doc));
		const remoteRecord = createRecord(
			remoteDoc,
			{ parentId: 'd1', blockType: 'paragraph' },
			REMOTE_ACTOR
		);
		deliverAsRemoteUpdate(doc, remoteDoc);

		expect(getRecord(doc, remoteRecord.id)).toBeDefined();
		expect(um.undoStack).toHaveLength(0);

		um.undo();
		expect(getRecord(doc, remoteRecord.id)).toBeDefined();

		remoteDoc.destroy();
	});

	it('undoing a local action never reverts an interleaved remote actor’s concurrent transaction', () => {
		createDocument(doc, { id: 'd1', title: 'Doc' });
		const um = createUndoManager(doc);
		um.stopCapturing();

		const localRecord = createRecord(doc, { parentId: 'd1', blockType: 'paragraph' }, HUMAN);
		um.stopCapturing();

		// A remote peer concurrently creates its own, independent block and
		// syncs it in — same as it would over /ws in the real app.
		const remoteDoc = new Y.Doc();
		Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(doc));
		const remoteRecord = createRecord(
			remoteDoc,
			{ parentId: 'd1', blockType: 'paragraph' },
			REMOTE_ACTOR
		);
		deliverAsRemoteUpdate(doc, remoteDoc);

		expect(getDocument(doc, 'd1')?.recordIds).toEqual([localRecord.id, remoteRecord.id]);

		um.undo();

		// Only the local actor's own block is reverted...
		expect(getRecord(doc, localRecord.id)).toBeUndefined();
		// ...the remote actor's concurrent, independent transaction survives untouched.
		expect(getRecord(doc, remoteRecord.id)).toBeDefined();
		expect(getDocument(doc, 'd1')?.recordIds).toEqual([remoteRecord.id]);

		remoteDoc.destroy();
	});

	it('redo restores exactly the undone local action, even after a remote edit lands in between', () => {
		createDocument(doc, { id: 'd1', title: 'Doc' });
		const um = createUndoManager(doc);
		um.stopCapturing();

		const localRecord = createRecord(doc, { parentId: 'd1', blockType: 'paragraph' }, HUMAN);
		doc.transact(() => getRecordYText(doc, localRecord.id)!.insert(0, 'Local text'));
		um.stopCapturing();

		um.undo();
		expect(getRecord(doc, localRecord.id)).toBeUndefined();

		// A remote peer writes a completely unrelated block while the undone
		// action is sitting on the redo stack.
		const remoteDoc = new Y.Doc();
		Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(doc));
		const remoteRecord = createRecord(
			remoteDoc,
			{ parentId: 'd1', blockType: 'paragraph' },
			REMOTE_ACTOR
		);
		deliverAsRemoteUpdate(doc, remoteDoc);

		um.redo();

		// Exactly the reverted local action comes back, content included...
		expect(getRecord(doc, localRecord.id)).toBeDefined();
		expect(getRecordYText(doc, localRecord.id)?.toString()).toBe('Local text');
		// ...and the remote edit that landed in between is untouched by the redo.
		expect(getRecord(doc, remoteRecord.id)).toBeDefined();
		const ids = getDocument(doc, 'd1')?.recordIds ?? [];
		expect(ids).toContain(localRecord.id);
		expect(ids).toContain(remoteRecord.id);

		remoteDoc.destroy();
	});

	it('does not let undo clobber a remote edit made to the very same property key', () => {
		createCollection(doc, {
			id: 'c1',
			title: 'Table',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		const row = createRecord(
			doc,
			{ parentId: 'c1', properties: { name: { type: 'text', value: 'A' } } },
			HUMAN
		);
		const um = createUndoManager(doc);
		um.stopCapturing();

		updateRecordProperties(doc, row.id, { name: { type: 'text', value: 'B' } }, HUMAN);
		um.stopCapturing();

		// A remote peer independently changes the SAME property key before
		// the local undo runs.
		const remoteDoc = new Y.Doc();
		Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(doc));
		updateRecordProperties(
			remoteDoc,
			row.id,
			{ name: { type: 'text', value: 'Remote wins' } },
			REMOTE_ACTOR
		);
		deliverAsRemoteUpdate(doc, remoteDoc);
		expect(getRecord(doc, row.id)?.properties?.name).toEqual({
			type: 'text',
			value: 'Remote wins'
		});

		um.undo();

		// The remote actor's own edit to this key is never silently
		// overwritten by the local undo — Y.UndoManager's default
		// (ignoreRemoteMapChanges: false) leaves it as-is instead of
		// restoring the local pre-edit value over it.
		expect(getRecord(doc, row.id)?.properties?.name).toEqual({
			type: 'text',
			value: 'Remote wins'
		});

		remoteDoc.destroy();
	});
});

describe('undo/redo singleton (bound to getClientDoc())', () => {
	beforeEach(async () => {
		singletonDoc = new Y.Doc();
		// Each test gets a fresh Y.Doc; the module's cached manager must not
		// leak state from a previous test's doc.
		vi.resetModules();
	});

	afterEach(() => {
		singletonDoc.destroy();
	});

	it('undo()/redo() operate on the doc returned by getClientDoc()', async () => {
		createDocument(singletonDoc, { id: 'd1', title: 'Doc' });
		const { undo, redo, subscribeUndoRedoState } = await import('./undo');
		// Forces the module's lazy manager into existence before the action
		// under test, the same way the app's onMount subscribes immediately on
		// page load — otherwise a manager created only inside the first
		// undo() call would have nothing on its stack yet, since Y.UndoManager
		// only tracks transactions that occur after it's constructed.
		subscribeUndoRedoState(() => {});
		const record = createRecord(singletonDoc, { parentId: 'd1', blockType: 'paragraph' }, HUMAN);
		expect(getDocument(singletonDoc, 'd1')?.recordIds).toEqual([record.id]);

		undo();
		expect(getDocument(singletonDoc, 'd1')?.recordIds).toEqual([]);

		redo();
		expect(getDocument(singletonDoc, 'd1')?.recordIds).toEqual([record.id]);
	});

	it('subscribeUndoRedoState reports canUndo/canRedo and reacts as the stacks change', async () => {
		const { subscribeUndoRedoState, undo } = await import('./undo');
		createDocument(singletonDoc, { id: 'd1', title: 'Doc' });

		const onChange = vi.fn();
		const unsubscribe = subscribeUndoRedoState(onChange);
		expect(onChange).toHaveBeenLastCalledWith({ canUndo: false, canRedo: false });

		createRecord(singletonDoc, { parentId: 'd1', blockType: 'paragraph' }, HUMAN);
		expect(onChange).toHaveBeenLastCalledWith({ canUndo: true, canRedo: false });

		undo();
		expect(onChange).toHaveBeenLastCalledWith({ canUndo: false, canRedo: true });

		unsubscribe();
		createRecord(singletonDoc, { parentId: 'd1', blockType: 'paragraph' }, HUMAN);
		// No further calls after unsubscribe — still reflects the pre-unsubscribe state.
		expect(onChange).toHaveBeenLastCalledWith({ canUndo: false, canRedo: true });
	});
});
