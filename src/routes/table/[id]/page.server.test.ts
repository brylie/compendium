import { describe, expect, it } from 'vitest';
import { load } from './+page.server';
import { createCollection } from '$lib/data/records';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';

describe('routes/table/[id]/+page.server', () => {
	it('returns the collection title for an existing collection', () => {
		const { doc } = resolveWorkspaceContext();
		const collection = createCollection(doc, { title: 'My Table', schema: [] });

		const result = load({ params: { id: collection.id } } as Parameters<typeof load>[0]);

		expect(result).toEqual({ collectionId: collection.id, title: 'My Table' });
	});

	it('falls back to "Untitled Collection" for a nonexistent collection', () => {
		const result = load({ params: { id: 'nonexistent' } } as Parameters<typeof load>[0]);
		expect(result).toEqual({ collectionId: 'nonexistent', title: 'Untitled Collection' });
	});
});
