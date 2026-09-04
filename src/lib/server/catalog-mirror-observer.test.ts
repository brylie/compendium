import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import {
	LOCAL_UI_ORIGIN,
	remoteUiOrigin,
	SERVICE_ORIGIN,
	transactWithOrigin,
	UnknownMutationOriginError
} from '../mutation-origin';
import { createUndoManager } from '../client/undo';

const WS = 'default';
const SHARD = 'default';
const REMOTE_UI_ORIGIN = remoteUiOrigin('catalog-mirror-observer-test');

function bootstrap(doc: Y.Doc) {
	attachCatalogMirrorObserver(WS, doc);
	return ensureCatalogBootstrapped(WS, SHARD, doc);
}

function seedDocument(doc: Y.Doc, spaceId: string, title = 'Original Title') {
	const meta = transactWithOrigin(doc, SERVICE_ORIGIN, () => crdtCreateDocument(doc, { title }));
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
	const meta = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
		crdtCreateCollection(doc, { title, schema: [] })
	);
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
	});

	afterEach(() => {
		resetCatalogMirrorObserverForTests();
		doc.destroy();
	});

	it('mirrors a direct remote UI Document title edit into the catalog synchronously', () => {
		const document = seedDocument(doc, spaceId);

		doc.transact(() => {
			crdtUpdateDocumentTitle(doc, document.id, 'Renamed From The UI');
		}, REMOTE_UI_ORIGIN);
		expect(catalogDocTitle(document.id)).toBe('Renamed From The UI');
	});

	it('mirrors a direct remote UI Collection title edit into the catalog synchronously', () => {
		const collection = seedCollection(doc, spaceId);

		doc.transact(() => {
			crdtUpdateCollectionTitle(doc, collection.id, 'Renamed Collection');
		}, REMOTE_UI_ORIGIN);
		expect(catalogCollectionTitle(collection.id)).toBe('Renamed Collection');
	});

	it('does not mirror a named service write — services own their catalog projection', () => {
		const document = seedDocument(doc, spaceId);

		doc.transact(() => {
			crdtUpdateDocumentTitle(doc, document.id, 'Service Layer Rename');
		}, SERVICE_ORIGIN);
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
		}, REMOTE_UI_ORIGIN);
		const row = listCatalogDocuments(WS).find((d) => d.id === child.id);
		expect(row?.parentDocumentId).toBe(parent.id);
	});

	it('projects each UI edit immediately, retaining its latest value', () => {
		const document = seedDocument(doc, spaceId);

		doc.transact(() => crdtUpdateDocumentTitle(doc, document.id, 'First'), REMOTE_UI_ORIGIN);
		doc.transact(() => crdtUpdateDocumentTitle(doc, document.id, 'Second'), REMOTE_UI_ORIGIN);
		doc.transact(() => crdtUpdateDocumentTitle(doc, document.id, 'Third'), REMOTE_UI_ORIGIN);
		expect(catalogDocTitle(document.id)).toBe('Third');
	});

	it('projects undo and redo of a local UI title change', () => {
		const document = seedDocument(doc, spaceId);
		const undoManager = createUndoManager(doc);
		undoManager.stopCapturing();

		transactWithOrigin(doc, LOCAL_UI_ORIGIN, () =>
			crdtUpdateDocumentTitle(doc, document.id, 'Renamed From The UI')
		);
		expect(catalogDocTitle(document.id)).toBe('Renamed From The UI');

		undoManager.undo();
		expect(catalogDocTitle(document.id)).toBe('Original Title');

		undoManager.redo();
		expect(catalogDocTitle(document.id)).toBe('Renamed From The UI');
	});

	it('has no pending projection for shutdown to flush', () => {
		expect(() => flushPendingCatalogMirrorEvents()).not.toThrow();
	});

	it('rejects an unregistered origin even when it has a recognized source name', () => {
		expect(() =>
			doc.transact(() => doc.getMap('documents').set('bad', new Y.Map()), {
				source: 'service'
			})
		).toThrow(UnknownMutationOriginError);
	});
});
