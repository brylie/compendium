import { describe, expect, it } from 'vitest';
import { resolveRequestContext } from '$lib/server/request-context';
import { createDocument as rawCrdtCreateDocument } from '$lib/data/document-ops';
import { createRecord as rawCrdtCreateRecord, setRecordReferencedId } from '$lib/data/record-ops';
import { TEST_ORIGIN, transactWithOrigin } from '$lib/mutation-origin';
import { resolveSyncGroups } from './synced-blocks';
import type { ActorId } from '$lib/data/types';

const human: ActorId = { kind: 'human', userId: 'brylie' };

function crdtCreateDocument(...args: Parameters<typeof rawCrdtCreateDocument>) {
	return transactWithOrigin(args[0], TEST_ORIGIN, () => rawCrdtCreateDocument(...args));
}

function crdtCreateRecord(...args: Parameters<typeof rawCrdtCreateRecord>) {
	return transactWithOrigin(args[0], TEST_ORIGIN, () => rawCrdtCreateRecord(...args));
}

describe('services/synced-blocks: resolveSyncGroups (#242)', () => {
	it('finds a synced_block instance whose source lives in a different Document’s shard', () => {
		const context = resolveRequestContext(human);
		const store = context.workspaceStore;

		const shardA = store.resolve({ workspaceId: context.workspaceId, shardId: 'shard-a' });
		const documentA = crdtCreateDocument(shardA.doc, { title: 'Doc A' });
		const source = crdtCreateRecord(
			shardA.doc,
			{ parentId: documentA.id, blockType: 'paragraph' },
			human
		);

		const shardB = store.resolve({ workspaceId: context.workspaceId, shardId: 'shard-b' });
		const documentB = crdtCreateDocument(shardB.doc, { title: 'Doc B' });
		const instance = crdtCreateRecord(
			shardB.doc,
			{ parentId: documentB.id, blockType: 'synced_block' },
			human
		);
		transactWithOrigin(shardB.doc, TEST_ORIGIN, () =>
			setRecordReferencedId(shardB.doc, instance.id, source.id, human)
		);

		const groups = resolveSyncGroups(context, [source.id, instance.id]);

		expect(groups[source.id]?.source).toMatchObject({
			sourceDocumentId: documentA.id,
			sourceRecordId: source.id
		});
		expect(groups[source.id]?.instances).toEqual([
			expect.objectContaining({ sourceDocumentId: documentB.id, sourceRecordId: instance.id })
		]);

		// The instance's own card resolves its source via the same batch —
		// it has no instances of its own mirroring it.
		expect(groups[instance.id]?.source).toMatchObject({
			sourceDocumentId: documentB.id,
			sourceRecordId: instance.id
		});
		expect(groups[instance.id]?.instances).toEqual([]);
	});

	it('omits an id that resolves to nothing (never existed, or already deleted)', () => {
		const context = resolveRequestContext(human);
		const groups = resolveSyncGroups(context, ['does-not-exist']);
		expect(groups['does-not-exist']).toBeUndefined();
	});
});
