import { describe, expect, it } from 'vitest';
import { load } from './+page.server';
import { createCollection as rawCreateCollection } from '$lib/data/records';
import { TEST_ORIGIN, transactWithOrigin } from '$lib/mutation-origin';
import { createCollection as createCollectionService } from '$lib/services';
import { CURRENT_USER } from '$lib/server/current-user';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';

function createCollection(...args: Parameters<typeof rawCreateCollection>) {
	return transactWithOrigin(args[0], TEST_ORIGIN, () => rawCreateCollection(...args));
}

describe('routes/table/[id]/+page.server', () => {
	it('returns the collection title for an existing collection written directly to the default doc', () => {
		const { doc, defaultSpaceId } = resolveWorkspaceContext();
		const collection = createCollection(doc, { title: 'My Table', schema: [] });

		const result = load({
			params: { id: collection.id, spaceId: defaultSpaceId }
		} as Parameters<typeof load>[0]);

		expect(result).toEqual({ collectionId: collection.id, title: 'My Table' });
	});

	it('returns the collection title for a Collection living in its own shard (#120)', () => {
		const { defaultSpaceId } = resolveWorkspaceContext();
		const collection = createCollectionService(CURRENT_USER, { title: 'Sharded Table' });

		const result = load({
			params: { id: collection.id, spaceId: defaultSpaceId }
		} as Parameters<typeof load>[0]);

		expect(result).toEqual({ collectionId: collection.id, title: 'Sharded Table' });
	});

	it('falls back to "Untitled Collection" for a nonexistent collection', () => {
		const { defaultSpaceId } = resolveWorkspaceContext();
		const result = load({
			params: { id: 'nonexistent', spaceId: defaultSpaceId }
		} as Parameters<typeof load>[0]);
		expect(result).toEqual({ collectionId: 'nonexistent', title: 'Untitled Collection' });
	});
});
