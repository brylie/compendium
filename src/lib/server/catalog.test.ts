import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { eq } from 'drizzle-orm';
import { getDb } from './store';
import { catalogDocuments, catalogOutbox, catalogRevisions, spaces } from './db/schema';
import {
	createDocument as crdtCreateDocument,
	createCollection as crdtCreateCollection
} from '$lib/data/records';
import {
	ensureCatalogBootstrapped,
	listCatalogCollections,
	listCatalogDocuments,
	recordCatalogDocumentCreated,
	recordCatalogDocumentDeleted,
	recordCatalogDocumentMoved,
	recordCatalogDocumentTitleChanged,
	RecordIdConflictError,
	reserveDocumentLocator
} from './catalog';

const WS = 'default';
const SHARD = 'default';

function bootstrap() {
	const doc = new Y.Doc();
	return { doc, ...ensureCatalogBootstrapped(WS, SHARD, doc) };
}

describe('catalog: record locator uniqueness (#113 Phase A, §3.1)', () => {
	it('rejects a duplicate (workspaceId, recordId) reservation', () => {
		const { defaultSpaceId } = bootstrap();
		reserveDocumentLocator(WS, defaultSpaceId, 'doc-1', SHARD);
		expect(() => reserveDocumentLocator(WS, defaultSpaceId, 'doc-1', SHARD)).toThrow(
			RecordIdConflictError
		);
	});
});

describe('catalog: bootstrap and backfill', () => {
	it('creates exactly one default Space, idempotently, even across repeated calls', () => {
		const doc = new Y.Doc();
		const first = ensureCatalogBootstrapped(WS, SHARD, doc);
		const second = ensureCatalogBootstrapped(WS, SHARD, doc);
		expect(second.defaultSpaceId).toBe(first.defaultSpaceId);

		const rows = getDb().select().from(spaces).where(eq(spaces.workspaceId, WS)).all();
		expect(rows).toHaveLength(1);
	});

	it('backfills existing Y.Doc documents and collections into the catalog on first bootstrap', () => {
		const doc = new Y.Doc();
		const existingDoc = crdtCreateDocument(doc, { title: 'Pre-existing Doc' });
		const existingCollection = crdtCreateCollection(doc, {
			title: 'Pre-existing Table',
			schema: []
		});

		ensureCatalogBootstrapped(WS, SHARD, doc);

		const docs = listCatalogDocuments(WS);
		const collections = listCatalogCollections(WS);
		expect(docs.find((d) => d.id === existingDoc.id)?.title).toBe('Pre-existing Doc');
		expect(collections.find((c) => c.id === existingCollection.id)?.title).toBe(
			'Pre-existing Table'
		);
	});
});

describe('catalog: committed writes bump revision and append a published outbox row', () => {
	it('increments the workspace revision and records an outbox entry on document create', () => {
		const { defaultSpaceId } = bootstrap();
		const before =
			getDb()
				.select({ revision: catalogRevisions.revision })
				.from(catalogRevisions)
				.where(eq(catalogRevisions.workspaceId, WS))
				.get()?.revision ?? 0;

		reserveDocumentLocator(WS, defaultSpaceId, 'doc-rev', SHARD);
		recordCatalogDocumentCreated({
			workspaceId: WS,
			spaceId: defaultSpaceId,
			id: 'doc-rev',
			title: 'Revision Doc',
			order: 'a0',
			shardId: SHARD
		});

		const after = getDb()
			.select({ revision: catalogRevisions.revision })
			.from(catalogRevisions)
			.where(eq(catalogRevisions.workspaceId, WS))
			.get()?.revision;
		expect(after).toBe(before + 1);

		const outboxRows = getDb()
			.select()
			.from(catalogOutbox)
			.where(eq(catalogOutbox.workspaceId, WS))
			.all();
		const created = outboxRows.at(-1);
		expect(created?.status).toBe('published');
		expect(created?.revision).toBe(after);
		expect(created?.payload).toMatchObject({ documents: ['doc-rev'], op: 'create' });
	});
});

describe('catalog: parentDocumentId tolerates a parent not yet in the catalog', () => {
	it('creates a nested document even when its parent was never cataloged (e.g. written directly to the Y.Doc over Yjs sync, bypassing the service layer)', () => {
		const { defaultSpaceId } = bootstrap();
		// Simulates a Document created by a direct Yjs client write, never
		// going through reserveDocumentLocator/recordCatalogDocumentCreated —
		// a supported pattern (see db/schema.ts's parentDocumentId comment).
		const uncatalogedParentId = 'uncataloged-parent';

		reserveDocumentLocator(WS, defaultSpaceId, 'nested-child', SHARD);
		expect(() =>
			recordCatalogDocumentCreated({
				workspaceId: WS,
				spaceId: defaultSpaceId,
				id: 'nested-child',
				title: 'Nested Child',
				parentDocumentId: uncatalogedParentId,
				order: 'a0',
				shardId: SHARD
			})
		).not.toThrow();

		const child = listCatalogDocuments(WS).find((d) => d.id === 'nested-child');
		expect(child?.parentDocumentId).toBe(uncatalogedParentId);

		// Deleting the (never-cataloged) "parent" is a safe no-op, not a crash —
		// it never had a catalog row to begin with.
		expect(() => recordCatalogDocumentDeleted(WS, uncatalogedParentId)).not.toThrow();
		expect(listCatalogDocuments(WS).find((d) => d.id === 'nested-child')).toBeDefined();
	});
});

describe('catalog: document deletion cascades to descendants', () => {
	it('deletes a document and its nested children from the catalog in one call', () => {
		const { defaultSpaceId } = bootstrap();

		reserveDocumentLocator(WS, defaultSpaceId, 'parent', SHARD);
		recordCatalogDocumentCreated({
			workspaceId: WS,
			spaceId: defaultSpaceId,
			id: 'parent',
			title: 'Parent',
			order: 'a0',
			shardId: SHARD
		});
		reserveDocumentLocator(WS, defaultSpaceId, 'child', SHARD);
		recordCatalogDocumentCreated({
			workspaceId: WS,
			spaceId: defaultSpaceId,
			id: 'child',
			title: 'Child',
			parentDocumentId: 'parent',
			order: 'a0',
			shardId: SHARD
		});

		recordCatalogDocumentDeleted(WS, 'parent');

		const remaining = getDb()
			.select()
			.from(catalogDocuments)
			.where(eq(catalogDocuments.workspaceId, WS))
			.all();
		expect(remaining.find((d) => d.id === 'parent')).toBeUndefined();
		expect(remaining.find((d) => d.id === 'child')).toBeUndefined();

		// The freed id must be reservable again — proves the record_locator rows
		// for both parent and child were actually cleaned up, not just the
		// catalog_documents rows via FK cascade.
		expect(() => reserveDocumentLocator(WS, defaultSpaceId, 'parent', SHARD)).not.toThrow();
		expect(() => reserveDocumentLocator(WS, defaultSpaceId, 'child', SHARD)).not.toThrow();
	});

	it('moving a document updates its catalog parent/order', () => {
		const { defaultSpaceId } = bootstrap();
		reserveDocumentLocator(WS, defaultSpaceId, 'movable', SHARD);
		recordCatalogDocumentCreated({
			workspaceId: WS,
			spaceId: defaultSpaceId,
			id: 'movable',
			title: 'Movable',
			order: 'a0',
			shardId: SHARD
		});
		reserveDocumentLocator(WS, defaultSpaceId, 'new-parent', SHARD);
		recordCatalogDocumentCreated({
			workspaceId: WS,
			spaceId: defaultSpaceId,
			id: 'new-parent',
			title: 'New Parent',
			order: 'a1',
			shardId: SHARD
		});

		recordCatalogDocumentMoved(WS, 'movable', 'new-parent', 'a2');

		const row = getDb()
			.select()
			.from(catalogDocuments)
			.where(eq(catalogDocuments.id, 'movable'))
			.get();
		expect(row?.parentDocumentId).toBe('new-parent');
		expect(row?.order).toBe('a2');
	});

	it('renaming a document updates its catalog title', () => {
		const { defaultSpaceId } = bootstrap();
		reserveDocumentLocator(WS, defaultSpaceId, 'renamable', SHARD);
		recordCatalogDocumentCreated({
			workspaceId: WS,
			spaceId: defaultSpaceId,
			id: 'renamable',
			title: 'Before',
			order: 'a0',
			shardId: SHARD
		});

		recordCatalogDocumentTitleChanged(WS, 'renamable', 'After');

		const row = getDb()
			.select()
			.from(catalogDocuments)
			.where(eq(catalogDocuments.id, 'renamable'))
			.get();
		expect(row?.title).toBe('After');
	});
});
