import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { eq } from 'drizzle-orm';
import { getDb } from './store';
import {
	catalogDocuments,
	catalogOutbox,
	catalogRevisions,
	recordLocator,
	spaces
} from './db/schema';
import {
	createDocument as crdtCreateDocument,
	createCollection as crdtCreateCollection
} from '$lib/data/records';
import {
	createSpace,
	ensureCatalogBootstrapped,
	listCatalogCollections,
	listCatalogDocuments,
	recordCatalogDocumentCreated,
	recordCatalogDocumentDeleted,
	recordCatalogDocumentMoved,
	recordCatalogDocumentTitleChanged,
	RecordIdConflictError,
	reserveDocumentLocator,
	reserveCollectionLocator,
	recordCatalogCollectionCreated,
	recordCatalogCollectionTitleChanged,
	recordCatalogCollectionDeleted,
	reserveRecordLocator,
	releaseRecordLocator,
	resolveShardForParent,
	resolveShardForRecord
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

	it('keeps resolving the original default Space even after another Space is created (#133 regression)', () => {
		// Guards against a real bug: the original lookup here had no ORDER BY,
		// so once a second `spaces` row existed for this workspace, a bare
		// SELECT had no defined row order and could non-deterministically
		// return either Space's id as "the default" — silently misattributing
		// every subsequently-created Document/Collection's spaceId depending on
		// SQLite's query-plan whims, not a real bug repro until #133 actually
		// exercised a multi-Space workspace.
		const doc = new Y.Doc();
		const first = ensureCatalogBootstrapped(WS, SHARD, doc);

		createSpace(WS, 'Second Space');

		const second = ensureCatalogBootstrapped(WS, SHARD, doc);
		expect(second.defaultSpaceId).toBe(first.defaultSpaceId);
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

describe('catalog: two workspaces reusing the same record id stay isolated', () => {
	// record_locator scopes uniqueness to (workspaceId, recordId) — a bare
	// global `id` primary key on catalog_documents/catalog_collections would
	// let workspace A's reservation succeed, then throw an unhandled SQL
	// error the moment workspace B tried to insert its own row with the same
	// id. This proves the composite (workspaceId, id) primary key actually
	// allows that, and that mutating one workspace's row never touches the
	// other's.
	it('lets two workspaces each create a Document with the same id, and update/delete only affects the right one', () => {
		const docA = new Y.Doc();
		const { defaultSpaceId: spaceA } = ensureCatalogBootstrapped('workspace-a', SHARD, docA);
		const docB = new Y.Doc();
		const { defaultSpaceId: spaceB } = ensureCatalogBootstrapped('workspace-b', SHARD, docB);

		reserveDocumentLocator('workspace-a', spaceA, 'shared-id', SHARD);
		recordCatalogDocumentCreated({
			workspaceId: 'workspace-a',
			spaceId: spaceA,
			id: 'shared-id',
			title: 'Workspace A Doc',
			order: 'a0',
			shardId: SHARD
		});

		expect(() => {
			reserveDocumentLocator('workspace-b', spaceB, 'shared-id', SHARD);
			recordCatalogDocumentCreated({
				workspaceId: 'workspace-b',
				spaceId: spaceB,
				id: 'shared-id',
				title: 'Workspace B Doc',
				order: 'a0',
				shardId: SHARD
			});
		}).not.toThrow();

		recordCatalogDocumentTitleChanged('workspace-a', 'shared-id', 'Renamed A');
		expect(listCatalogDocuments('workspace-a').find((d) => d.id === 'shared-id')?.title).toBe(
			'Renamed A'
		);
		expect(listCatalogDocuments('workspace-b').find((d) => d.id === 'shared-id')?.title).toBe(
			'Workspace B Doc'
		);

		recordCatalogDocumentDeleted('workspace-a', 'shared-id');
		expect(listCatalogDocuments('workspace-a').find((d) => d.id === 'shared-id')).toBeUndefined();
		expect(listCatalogDocuments('workspace-b').find((d) => d.id === 'shared-id')?.title).toBe(
			'Workspace B Doc'
		);
	});

	it('lets two workspaces each create a Collection with the same id, and update/delete only affects the right one', () => {
		const docA = new Y.Doc();
		const { defaultSpaceId: spaceA } = ensureCatalogBootstrapped('workspace-c', SHARD, docA);
		const docB = new Y.Doc();
		const { defaultSpaceId: spaceB } = ensureCatalogBootstrapped('workspace-d', SHARD, docB);

		reserveCollectionLocator('workspace-c', spaceA, 'shared-collection-id', SHARD);
		recordCatalogCollectionCreated({
			workspaceId: 'workspace-c',
			spaceId: spaceA,
			id: 'shared-collection-id',
			title: 'Workspace C Table',
			shardId: SHARD
		});

		expect(() => {
			reserveCollectionLocator('workspace-d', spaceB, 'shared-collection-id', SHARD);
			recordCatalogCollectionCreated({
				workspaceId: 'workspace-d',
				spaceId: spaceB,
				id: 'shared-collection-id',
				title: 'Workspace D Table',
				shardId: SHARD
			});
		}).not.toThrow();

		recordCatalogCollectionTitleChanged('workspace-c', 'shared-collection-id', 'Renamed C');
		expect(
			listCatalogCollections('workspace-c').find((c) => c.id === 'shared-collection-id')?.title
		).toBe('Renamed C');
		expect(
			listCatalogCollections('workspace-d').find((c) => c.id === 'shared-collection-id')?.title
		).toBe('Workspace D Table');

		recordCatalogCollectionDeleted('workspace-c', 'shared-collection-id');
		expect(
			listCatalogCollections('workspace-c').find((c) => c.id === 'shared-collection-id')
		).toBeUndefined();
		expect(
			listCatalogCollections('workspace-d').find((c) => c.id === 'shared-collection-id')?.title
		).toBe('Workspace D Table');
	});
});

describe('catalog: record/row locator and shard resolution (#120)', () => {
	it('resolveShardForParent finds a Document or Collection by its own id', () => {
		const { defaultSpaceId } = bootstrap();
		reserveDocumentLocator(WS, defaultSpaceId, 'a-document', SHARD);
		reserveCollectionLocator(WS, defaultSpaceId, 'a-collection', 'other-shard');

		expect(resolveShardForParent(WS, 'a-document')).toEqual({
			shardId: SHARD,
			kind: 'document',
			spaceId: defaultSpaceId
		});
		expect(resolveShardForParent(WS, 'a-collection')).toEqual({
			shardId: 'other-shard',
			kind: 'collection',
			spaceId: defaultSpaceId
		});
	});

	it('resolveShardForParent returns undefined for an untracked id', () => {
		bootstrap();
		expect(resolveShardForParent(WS, 'never-created')).toBeUndefined();
	});

	it('reserves and resolves a record/row locator independently of Document/Collection locators', () => {
		const { defaultSpaceId } = bootstrap();
		reserveRecordLocator(WS, defaultSpaceId, 'row-1', 'collection-shard-x');

		expect(resolveShardForRecord(WS, 'row-1')).toEqual({ shardId: 'collection-shard-x' });
		// A record-kind locator entry must never satisfy a parent lookup — a
		// row is never itself a valid parentId.
		expect(resolveShardForParent(WS, 'row-1')).toBeUndefined();
	});

	it('releaseRecordLocator removes the entry, and the id becomes reservable again', () => {
		const { defaultSpaceId } = bootstrap();
		reserveRecordLocator(WS, defaultSpaceId, 'row-2', SHARD);
		expect(resolveShardForRecord(WS, 'row-2')).toEqual({ shardId: SHARD });

		releaseRecordLocator(WS, 'row-2');

		expect(resolveShardForRecord(WS, 'row-2')).toBeUndefined();
		expect(() => reserveRecordLocator(WS, defaultSpaceId, 'row-2', SHARD)).not.toThrow();
	});

	it('releaseRecordLocator on a never-reserved id is a safe no-op', () => {
		bootstrap();
		expect(() => releaseRecordLocator(WS, 'never-reserved')).not.toThrow();
	});

	it('rejects a duplicate record id reservation, consistent with Document/Collection locators', () => {
		const { defaultSpaceId } = bootstrap();
		reserveRecordLocator(WS, defaultSpaceId, 'row-3', SHARD);
		expect(() => reserveRecordLocator(WS, defaultSpaceId, 'row-3', SHARD)).toThrow(
			RecordIdConflictError
		);
	});
});

describe('catalog: spaceId is workspace-scoped, not just globally unique', () => {
	it('rejects a catalog_documents row whose workspaceId disagrees with its spaceId’s real workspace', () => {
		const { defaultSpaceId } = bootstrap();
		expect(() =>
			getDb()
				.insert(catalogDocuments)
				.values({
					id: 'mismatched-doc',
					workspaceId: 'a-different-workspace', // defaultSpaceId belongs to WS ('default'), not this one
					spaceId: defaultSpaceId,
					shardId: SHARD,
					title: 'Should Be Rejected',
					order: 'a0',
					createdAt: Date.now(),
					updatedAt: Date.now()
				})
				.run()
		).toThrow(/FOREIGN KEY constraint failed/);
	});

	it('rejects a record_locator row whose workspaceId disagrees with its spaceId’s real workspace', () => {
		const { defaultSpaceId } = bootstrap();
		expect(() =>
			getDb()
				.insert(recordLocator)
				.values({
					workspaceId: 'a-different-workspace',
					recordId: 'mismatched-record',
					kind: 'document',
					spaceId: defaultSpaceId,
					shardId: SHARD,
					createdAt: Date.now()
				})
				.run()
		).toThrow(/FOREIGN KEY constraint failed/);
	});

	it('accepts a row whose workspaceId correctly matches its spaceId’s real workspace', () => {
		const { defaultSpaceId } = bootstrap();
		expect(() =>
			getDb()
				.insert(catalogDocuments)
				.values({
					id: 'matched-doc',
					workspaceId: WS,
					spaceId: defaultSpaceId,
					shardId: SHARD,
					title: 'Correctly Matched',
					order: 'a0',
					createdAt: Date.now(),
					updatedAt: Date.now()
				})
				.run()
		).not.toThrow();
	});
});
