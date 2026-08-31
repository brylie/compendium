import { describe, expect, it } from 'vitest';
import { load } from './+page.server';
import { createDocument } from '$lib/data/records';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';

describe('routes/doc/[id]/+page.server', () => {
	it('returns the document title for an existing document', () => {
		const { doc } = resolveWorkspaceContext();
		const docMeta = createDocument(doc, { title: 'My Doc' });

		const result = load({ params: { id: docMeta.id } } as Parameters<typeof load>[0]);

		expect(result).toEqual({ documentId: docMeta.id, title: 'My Doc', collections: [] });
	});

	it('falls back to "Untitled" for a nonexistent document', () => {
		const result = load({ params: { id: 'nonexistent' } } as Parameters<typeof load>[0]);
		expect(result).toEqual({ documentId: 'nonexistent', title: 'Untitled', collections: [] });
	});
});
