import { describe, expect, it } from 'vitest';
import { load } from './+page.server';
import { createCollection } from '$lib/data/records';
import { getYDoc } from '$lib/server/ydoc';

describe('routes/board/[id]/+page.server', () => {
	it('returns the collection title for an existing collection', () => {
		const doc = getYDoc();
		const collection = createCollection(doc, { title: 'My Board', schema: [] });

		const result = load({ params: { id: collection.id } } as Parameters<typeof load>[0]);

		expect(result).toEqual({ collectionId: collection.id, title: 'My Board' });
	});

	it('falls back to "Untitled Collection" for a nonexistent collection', () => {
		const result = load({ params: { id: 'nonexistent' } } as Parameters<typeof load>[0]);
		expect(result).toEqual({ collectionId: 'nonexistent', title: 'Untitled Collection' });
	});
});
