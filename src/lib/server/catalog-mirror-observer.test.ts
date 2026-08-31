import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
	createDocument as crdtCreateDocument,
	createCollection as crdtCreateCollection,
	updateDocumentTitle as crdtUpdateDocumentTitle,
	updateDocumentParent as crdtUpdateDocumentParent,
	updateCollectionTitle as crdtUpdateCollectionTitle
} from '$lib/data/records';
import {
	ensureCatalogBootstrapped,
	listCatalogCollections,
	listCatalogDocuments,
	recordCatalogCollectionCreated,
	recordCatalogDocumentCreated
} from './catalog';
import {
	attachCatalogMirrorObserver,
	flushPendingCatalogMirrorEvents,
	resetCatalogMirrorObserverForTests
} from './catalog-mirror-observer';

const WS = 'default';
const SHARD = 'default';

function bootstrap(doc: Y.Doc) {
	attachCatalogMirrorObserver(WS, doc);
	return ensureCatalogBootstrapped(WS, SHARD, doc);
}

function seedDocument(doc: Y.Doc, spaceId: string, title = 'Original Title') {
	const meta = crdtCreateDocument(doc, { title });
	recordCatalogDocumentCreated({
		workspaceId: WS,
		spaceId,
		id: meta.id,
		title: meta.title,
		order: meta.order,
		shardId: SHARD
	});
	return meta;
}

function seedCollection(doc: Y.Doc, spaceId: string, title = 'Original Title') {
	const meta = crdtCreateCollection(doc, { title, schema: [] });
	recordCatalogCollectionCreated({
		workspaceId: WS,
		spaceId,
		id: meta.id,
		title: meta.title,
		shardId: SHARD
	});
	return meta;
}

function catalogDocTitle(id: string): string | undefined {
	return listCatalogDocuments(WS).find((d) => d.id === id)?.title;
}

function catalogCollectionTitle(id: string): string | undefined {
	return listCatalogCollections(WS).find((c) => c.id === id)?.title;
}

describe('catalog-mirror-observer: mirroring direct UI title/hierarchy edits into the catalog', () => {
	let doc: Y.Doc;
	let spaceId: string;

	beforeEach(() => {
		doc = new Y.Doc();
		({ defaultSpaceId: spaceId } = bootstrap(doc));
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		resetCatalogMirrorObserverForTests();
		doc.destroy();
	});

	it('mirrors a direct (client-origin) Document title edit into the catalog after the debounce window', () => {
		const document = seedDocument(doc, spaceId);

		doc.transact(() => {
			crdtUpdateDocumentTitle(doc, document.id, 'Renamed From The UI');
		}, 'fake-ws-connection');

		expect(catalogDocTitle(document.id)).toBe('Original Title');
		vi.advanceTimersByTime(3_000);
		expect(catalogDocTitle(document.id)).toBe('Renamed From The UI');
	});

	it('mirrors a direct Collection title edit into the catalog after the debounce window', () => {
		const collection = seedCollection(doc, spaceId);

		doc.transact(() => {
			crdtUpdateCollectionTitle(doc, collection.id, 'Renamed Collection');
		}, 'fake-ws-connection');

		expect(catalogCollectionTitle(collection.id)).toBe('Original Title');
		vi.advanceTimersByTime(3_000);
		expect(catalogCollectionTitle(collection.id)).toBe('Renamed Collection');
	});

	it('does not mirror a null-origin (service-layer) write — the service function already dual-writes the catalog itself', () => {
		const document = seedDocument(doc, spaceId);

		doc.transact(() => {
			crdtUpdateDocumentTitle(doc, document.id, 'Service Layer Rename');
		});

		vi.advanceTimersByTime(3_000);
		// The catalog is never told about this rename by the observer — a real
		// service-layer caller would have called recordCatalogDocumentTitleChanged
		// itself, which this test deliberately doesn't do, to prove the observer
		// stays out of the way.
		expect(catalogDocTitle(document.id)).toBe('Original Title');
	});

	it('mirrors a direct parentDocumentId/order change (a move) into the catalog', () => {
		const parent = seedDocument(doc, spaceId, 'Parent');
		const child = seedDocument(doc, spaceId, 'Child');

		doc.transact(() => {
			crdtUpdateDocumentParent(doc, child.id, parent.id);
		}, 'fake-ws-connection');

		vi.advanceTimersByTime(3_000);
		const row = listCatalogDocuments(WS).find((d) => d.id === child.id);
		expect(row?.parentDocumentId).toBe(parent.id);
	});

	it('coalesces rapid successive edits to the same Document into one catalog write, using its latest value', () => {
		const document = seedDocument(doc, spaceId);

		doc.transact(() => crdtUpdateDocumentTitle(doc, document.id, 'First'), 'fake-ws-connection');
		vi.advanceTimersByTime(1_000);
		doc.transact(() => crdtUpdateDocumentTitle(doc, document.id, 'Second'), 'fake-ws-connection');
		vi.advanceTimersByTime(1_000);
		doc.transact(() => crdtUpdateDocumentTitle(doc, document.id, 'Third'), 'fake-ws-connection');

		// Still inside the debounce window from the most recent edit.
		expect(catalogDocTitle(document.id)).toBe('Original Title');

		vi.advanceTimersByTime(3_000);
		expect(catalogDocTitle(document.id)).toBe('Third');
	});

	it('flushPendingCatalogMirrorEvents writes a pending debounced mirror immediately', () => {
		const document = seedDocument(doc, spaceId);

		doc.transact(() => crdtUpdateDocumentTitle(doc, document.id, 'Flushed'), 'fake-ws-connection');
		expect(catalogDocTitle(document.id)).toBe('Original Title');

		flushPendingCatalogMirrorEvents();
		expect(catalogDocTitle(document.id)).toBe('Flushed');
	});

	it('is a no-op when the entry was deleted before its debounce window elapsed', () => {
		const document = seedDocument(doc, spaceId);

		doc.transact(() => crdtUpdateDocumentTitle(doc, document.id, 'Renamed'), 'fake-ws-connection');
		doc.transact(() => {
			doc.getMap('documents').delete(document.id);
		}, 'fake-ws-connection');

		// Must not throw when the pending mirror fires against a now-deleted entry.
		expect(() => vi.advanceTimersByTime(3_000)).not.toThrow();
	});

	it("debounces a same-id entry independently per Y.Doc, so one workspace does not clobber another's pending mirror", () => {
		// A document id is only unique within its own workspace (catalog_documents'
		// primary key is (workspace_id, id) — see db/schema.ts), so two different
		// docs sharing an id, as this test needs to prove per-Y.Doc scoping, must
		// belong to two different workspaces, not the same one.
		const WS_B = 'other-workspace';
		const docB = new Y.Doc();
		attachCatalogMirrorObserver(WS_B, docB);
		const { defaultSpaceId: spaceIdB } = ensureCatalogBootstrapped(WS_B, SHARD, docB);

		try {
			const sharedId = 'shared-doc-id';
			crdtCreateDocument(doc, { id: sharedId, title: 'A Original' });
			recordCatalogDocumentCreated({
				workspaceId: WS,
				spaceId,
				id: sharedId,
				title: 'A Original',
				order: 'a0',
				shardId: SHARD
			});
			crdtCreateDocument(docB, { id: sharedId, title: 'B Original' });
			recordCatalogDocumentCreated({
				workspaceId: WS_B,
				spaceId: spaceIdB,
				id: sharedId,
				title: 'B Original',
				order: 'a0',
				shardId: SHARD
			});

			doc.transact(() => crdtUpdateDocumentTitle(doc, sharedId, 'A Renamed'), 'ws-a');
			vi.advanceTimersByTime(1_000);
			docB.transact(() => crdtUpdateDocumentTitle(docB, sharedId, 'B Renamed'), 'ws-b');

			vi.advanceTimersByTime(3_000);
			// Both docs' pending mirrors must have fired on their own schedule —
			// neither cleared the other's timer.
			expect(catalogDocTitle(sharedId)).toBe('A Renamed');
			expect(listCatalogDocuments(WS_B).find((d) => d.id === sharedId)?.title).toBe('B Renamed');
		} finally {
			docB.destroy();
		}
	});
});
