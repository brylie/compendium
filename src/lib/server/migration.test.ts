import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
	createCollection as rawCrdtCreateCollection,
	createDocument as rawCrdtCreateDocument,
	createRecord as rawCrdtCreateRecord,
	getCollection as crdtGetCollection,
	getDocument as crdtGetDocument,
	getRecord as crdtGetRecord
} from '$lib/data/records';
import { TEST_ORIGIN, transactWithOrigin } from '$lib/mutation-origin';
import { CURRENT_USER } from './current-user';
import { listDocuments } from '../services/documents';
import { listCatalogDocuments } from './catalog';
import { getDb } from './store';
import { catalogDocuments, migrationRuns, migrationTargets, snapshots } from './db/schema';
import { resolveWorkspaceContext } from './workspace-store';
import { migrateWorkspace } from './migration';

const WS = 'migration-test-ws';
const actor = CURRENT_USER;

function crdtCreateDocument(...args: Parameters<typeof rawCrdtCreateDocument>) {
	return transactWithOrigin(args[0], TEST_ORIGIN, () => rawCrdtCreateDocument(...args));
}

function crdtCreateCollection(...args: Parameters<typeof rawCrdtCreateCollection>) {
	return transactWithOrigin(args[0], TEST_ORIGIN, () => rawCrdtCreateCollection(...args));
}

function crdtCreateRecord(...args: Parameters<typeof rawCrdtCreateRecord>) {
	return transactWithOrigin(args[0], TEST_ORIGIN, () => rawCrdtCreateRecord(...args));
}

describe('migration: lossless content migration (#114/#132, workspace-sharding.md §7)', () => {
	it('migrates a Document hierarchy, a page-link reference, and a Collection with a relation, preserving every id/order/content field exactly', () => {
		const { doc } = resolveWorkspaceContext({ workspaceId: WS });

		const parent = crdtCreateDocument(doc, { title: 'Parent Doc' });
		const child = crdtCreateDocument(doc, { title: 'Child Doc', parentDocumentId: parent.id });
		const block = crdtCreateRecord(
			doc,
			{ parentId: parent.id, blockType: 'page_link', referencedRecordId: child.id },
			actor
		);

		const collection = crdtCreateCollection(doc, {
			title: 'Related Table',
			schema: [{ key: 'rel', label: 'Related', type: 'relation' }]
		});
		const rowA = crdtCreateRecord(doc, { parentId: collection.id, properties: {} }, actor);
		const rowB = crdtCreateRecord(
			doc,
			{
				parentId: collection.id,
				properties: { rel: { type: 'relation', value: [rowA.id] } }
			},
			actor
		);

		const result = migrateWorkspace({ workspaceId: WS });

		expect(new Set(result.targetsMigrated)).toEqual(new Set([parent.id, child.id, collection.id]));
		expect(result.targetsAlreadyDurable).toEqual([]);

		const { doc: parentShard } = resolveWorkspaceContext({ workspaceId: WS, shardId: parent.id });
		const migratedParent = crdtGetDocument(parentShard, parent.id);
		expect(migratedParent?.title).toBe('Parent Doc');
		expect(migratedParent?.order).toBe(parent.order);
		expect(migratedParent?.parentDocumentId).toBeUndefined();

		const migratedBlock = crdtGetRecord(parentShard, block.id);
		expect(migratedBlock?.blockType).toBe('page_link');
		expect(migratedBlock?.referencedRecordId).toBe(child.id);
		expect(migratedBlock?.order).toBe(block.order);
		expect(migratedBlock?.createdAt).toBe(block.createdAt);
		expect(migratedBlock?.createdBy).toEqual(actor);

		const { doc: childShard } = resolveWorkspaceContext({ workspaceId: WS, shardId: child.id });
		const migratedChild = crdtGetDocument(childShard, child.id);
		expect(migratedChild?.title).toBe('Child Doc');
		// parentDocumentId preserved exactly, even though the parent now lives
		// in an entirely different shard — hierarchy is a catalog/id concern,
		// not a Yjs-nesting one.
		expect(migratedChild?.parentDocumentId).toBe(parent.id);

		const { doc: collectionShard } = resolveWorkspaceContext({
			workspaceId: WS,
			shardId: collection.id
		});
		const migratedCollection = crdtGetCollection(collectionShard, collection.id);
		expect(migratedCollection?.title).toBe('Related Table');
		expect(migratedCollection?.schema).toEqual(collection.schema);

		const migratedRowB = crdtGetRecord(collectionShard, rowB.id);
		expect(migratedRowB?.properties?.rel).toEqual({ type: 'relation', value: [rowA.id] });
	});
});

describe('migration: idempotent re-run', () => {
	it('running twice migrates nothing new the second time and creates no duplicate rows', () => {
		const { doc } = resolveWorkspaceContext({ workspaceId: WS });
		const document = crdtCreateDocument(doc, { title: 'Once Doc' });

		const first = migrateWorkspace({ workspaceId: WS });
		expect(first.targetsMigrated).toEqual([document.id]);

		const second = migrateWorkspace({ workspaceId: WS });
		expect(second.targetsMigrated).toEqual([]);
		expect(second.targetsAlreadyDurable).toEqual([document.id]);
		expect(second.runId).toBe(first.runId);

		const targetRows = getDb()
			.select()
			.from(migrationTargets)
			.where(eq(migrationTargets.legacyId, document.id))
			.all();
		expect(targetRows).toHaveLength(1);

		const catalogRows = listCatalogDocuments(WS).filter((d) => d.id === document.id);
		expect(catalogRows).toHaveLength(1);
	});

	it('resumes correctly when content is added to the legacy doc between runs', () => {
		const { doc } = resolveWorkspaceContext({ workspaceId: WS });
		const docA = crdtCreateDocument(doc, { title: 'Doc A' });

		const first = migrateWorkspace({ workspaceId: WS });
		expect(first.targetsMigrated).toEqual([docA.id]);

		const docB = crdtCreateDocument(doc, { title: 'Doc B' });

		const second = migrateWorkspace({ workspaceId: WS });
		expect(second.targetsMigrated).toEqual([docB.id]);
		expect(second.targetsAlreadyDurable).toEqual([docA.id]);
		expect(second.runId).toBe(first.runId);
	});
});

describe('migration: dry run performs no writes', () => {
	it('reports targets without creating any manifest, catalog, or snapshot rows', () => {
		const { doc } = resolveWorkspaceContext({ workspaceId: WS });
		const document = crdtCreateDocument(doc, { title: 'Dry Run Doc' });

		const result = migrateWorkspace({ workspaceId: WS, dryRun: true });

		expect(result.dryRun).toBe(true);
		expect(result.targetsMigrated).toEqual([document.id]);
		expect(result.runId).toBe(-1);

		const runRows = getDb().select().from(migrationRuns).all();
		expect(runRows).toHaveLength(0);

		const targetRows = getDb().select().from(migrationTargets).all();
		expect(targetRows).toHaveLength(0);

		const snapshotRows = getDb()
			.select()
			.from(snapshots)
			.where(eq(snapshots.shardId, document.id))
			.all();
		expect(snapshotRows).toHaveLength(0);
	});
});

describe('migration: post-migration reads resolve via the catalog, not the uncataloged fallback', () => {
	it('lists a migrated Document with its real shard id, not the default shard', () => {
		const { doc } = resolveWorkspaceContext();
		const document = crdtCreateDocument(doc, { title: 'Fallback Then Catalog Doc' });

		const beforeMigration = listDocuments(CURRENT_USER).find((d) => d.id === document.id);
		expect(beforeMigration?.title).toBe('Fallback Then Catalog Doc');

		migrateWorkspace();

		const afterMigration = listDocuments(CURRENT_USER).find((d) => d.id === document.id);
		expect(afterMigration?.title).toBe('Fallback Then Catalog Doc');

		const catalogRow = listCatalogDocuments('default').find((d) => d.id === document.id);
		expect(catalogRow).toBeDefined();

		const rawRow = getDb()
			.select()
			.from(catalogDocuments)
			.all()
			.find((r) => r.id === document.id);
		expect(rawRow?.shardId).toBe(document.id);
	});
});
