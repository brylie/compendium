import { describe, expect, it } from 'vitest';
import { load } from './+page.server';
import { createCollection } from '$lib/data/records';
import { createCollection as createCollectionService } from '$lib/services';
import { CURRENT_USER } from '$lib/server/current-user';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';

describe('routes/table/[id]/+page.server', () => {
	it('returns the collection title for an existing collection written directly to the default doc', () => {
		const { doc } = resolveWorkspaceContext();
		const collection = createCollection(doc, { title: 'My Table', schema: [] });

		const result = load({ params: { id: collection.id } } as Parameters<typeof load>[0]);

		expect(result).toEqual({ collectionId: collection.id, title: 'My Table' });
	});

	it('returns the collection title for a Collection living in its own shard (#120)', () => {
		const collection = createCollectionService(CURRENT_USER, { title: 'Sharded Table' });

		const result = load({ params: { id: collection.id } } as Parameters<typeof load>[0]);

		expect(result).toEqual({ collectionId: collection.id, title: 'Sharded Table' });
	});

	it('falls back to "Untitled Collection" for a nonexistent collection', () => {
		const result = load({ params: { id: 'nonexistent' } } as Parameters<typeof load>[0]);
		expect(result).toEqual({ collectionId: 'nonexistent', title: 'Untitled Collection' });
	});
});
