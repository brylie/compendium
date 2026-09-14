import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createDocument as crdtCreateDocument } from '$lib/data/document-ops';
import {
	createRecord as crdtCreateRecord,
	deleteRecord as crdtDeleteRecord,
	setRecordReferencedId
} from '$lib/data/record-ops';
import {
	listSyncedBlockInstancesAcrossShards,
	rebuildSyncedBlockIndexForShard,
	upsertSyncedBlockInstanceEntry
} from './synced-block-index';
import { SERVICE_ORIGIN, transactWithOrigin } from '../mutation-origin';
import type { ActorId } from '$lib/data/types';

const WS = 'default';
const actor: ActorId = { kind: 'human', userId: 'brylie' };

function seedDocument(doc: Y.Doc, title = 'Doc') {
	return transactWithOrigin(doc, SERVICE_ORIGIN, () => crdtCreateDocument(doc, { title }));
}

describe('synced-block-index: rebuilding from Y.Doc state (#242)', () => {
	let doc: Y.Doc;

	beforeEach(() => {
		doc = new Y.Doc();
	});

	afterEach(() => {
		doc.destroy();
	});

	it('indexes a synced_block instance under its source id', () => {
		const document = seedDocument(doc);
		const source = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			crdtCreateRecord(doc, { parentId: document.id, blockType: 'paragraph' }, actor)
		);
		const instance = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			crdtCreateRecord(doc, { parentId: document.id, blockType: 'synced_block' }, actor)
		);
		transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			setRecordReferencedId(doc, instance.id, source.id, actor)
		);

		rebuildSyncedBlockIndexForShard(WS, 'shard-a', doc);

		const rows = listSyncedBlockInstancesAcrossShards(WS, [source.id]);
		expect(rows).toEqual([
			{ sourceRecordId: source.id, instanceRecordId: instance.id, instanceShardId: 'shard-a' }
		]);
	});

	it('finds a synced_block instance whose source lives in a different shard', () => {
		const shardADoc = new Y.Doc();
		const shardBDoc = new Y.Doc();
		try {
			const documentA = seedDocument(shardADoc, 'Doc A');
			const source = transactWithOrigin(shardADoc, SERVICE_ORIGIN, () =>
				crdtCreateRecord(shardADoc, { parentId: documentA.id, blockType: 'paragraph' }, actor)
			);
			rebuildSyncedBlockIndexForShard(WS, 'shard-a', shardADoc);

			const documentB = seedDocument(shardBDoc, 'Doc B');
			const instance = transactWithOrigin(shardBDoc, SERVICE_ORIGIN, () =>
				crdtCreateRecord(shardBDoc, { parentId: documentB.id, blockType: 'synced_block' }, actor)
			);
			transactWithOrigin(shardBDoc, SERVICE_ORIGIN, () =>
				setRecordReferencedId(shardBDoc, instance.id, source.id, actor)
			);
			rebuildSyncedBlockIndexForShard(WS, 'shard-b', shardBDoc);

			const rows = listSyncedBlockInstancesAcrossShards(WS, [source.id]);
			expect(rows).toEqual([
				{ sourceRecordId: source.id, instanceRecordId: instance.id, instanceShardId: 'shard-b' }
			]);
		} finally {
			shardADoc.destroy();
			shardBDoc.destroy();
		}
	});

	it('clears a stale row once the synced_block no longer references anything', () => {
		const document = seedDocument(doc);
		const source = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			crdtCreateRecord(doc, { parentId: document.id, blockType: 'paragraph' }, actor)
		);
		const instance = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			crdtCreateRecord(doc, { parentId: document.id, blockType: 'synced_block' }, actor)
		);
		transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			setRecordReferencedId(doc, instance.id, source.id, actor)
		);
		upsertSyncedBlockInstanceEntry(WS, 'shard-a', doc, instance.id);
		expect(listSyncedBlockInstancesAcrossShards(WS, [source.id])).toHaveLength(1);

		transactWithOrigin(doc, SERVICE_ORIGIN, () => crdtDeleteRecord(doc, instance.id));
		upsertSyncedBlockInstanceEntry(WS, 'shard-a', doc, instance.id);

		expect(listSyncedBlockInstancesAcrossShards(WS, [source.id])).toEqual([]);
	});

	it('rebuild wipes only the given shard’s prior rows', () => {
		const document = seedDocument(doc);
		const source = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			crdtCreateRecord(doc, { parentId: document.id, blockType: 'paragraph' }, actor)
		);
		const instance = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			crdtCreateRecord(doc, { parentId: document.id, blockType: 'synced_block' }, actor)
		);
		transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			setRecordReferencedId(doc, instance.id, source.id, actor)
		);
		rebuildSyncedBlockIndexForShard(WS, 'shard-a', doc);

		const otherDoc = new Y.Doc();
		try {
			const otherDocument = seedDocument(otherDoc, 'Other');
			const otherSource = transactWithOrigin(otherDoc, SERVICE_ORIGIN, () =>
				crdtCreateRecord(otherDoc, { parentId: otherDocument.id, blockType: 'paragraph' }, actor)
			);
			const otherInstance = transactWithOrigin(otherDoc, SERVICE_ORIGIN, () =>
				crdtCreateRecord(otherDoc, { parentId: otherDocument.id, blockType: 'synced_block' }, actor)
			);
			transactWithOrigin(otherDoc, SERVICE_ORIGIN, () =>
				setRecordReferencedId(otherDoc, otherInstance.id, otherSource.id, actor)
			);
			rebuildSyncedBlockIndexForShard(WS, 'shard-b', otherDoc);

			// Rebuilding shard-a again must not disturb shard-b's own rows.
			rebuildSyncedBlockIndexForShard(WS, 'shard-a', doc);

			expect(listSyncedBlockInstancesAcrossShards(WS, [source.id])).toHaveLength(1);
			expect(listSyncedBlockInstancesAcrossShards(WS, [otherSource.id])).toHaveLength(1);
		} finally {
			otherDoc.destroy();
		}
	});

	it('returns no rows for an empty source id list, without querying the database', () => {
		expect(listSyncedBlockInstancesAcrossShards(WS, [])).toEqual([]);
	});

	it('rebuilds a shard whose row count spans more than one insert batch (issue #310 review)', () => {
		const document = seedDocument(doc);
		const source = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			crdtCreateRecord(doc, { parentId: document.id, blockType: 'paragraph' }, actor)
		);
		// One more than 2× the 100-row insert batch size, so the rebuild's
		// chunked insert loop runs three times (100 + 100 + 1), not once.
		const instanceCount = 201;
		const instanceIds: string[] = [];
		transactWithOrigin(doc, SERVICE_ORIGIN, () => {
			for (let i = 0; i < instanceCount; i++) {
				const instance = crdtCreateRecord(
					doc,
					{ parentId: document.id, blockType: 'synced_block' },
					actor
				);
				setRecordReferencedId(doc, instance.id, source.id, actor);
				instanceIds.push(instance.id);
			}
		});

		rebuildSyncedBlockIndexForShard(WS, 'shard-batch', doc);

		const rows = listSyncedBlockInstancesAcrossShards(WS, [source.id]);
		expect(rows).toHaveLength(instanceCount);
		expect(new Set(rows.map((row) => row.instanceRecordId))).toEqual(new Set(instanceIds));
	});
});
