import { describe, expect, it } from 'vitest';
import { load } from './+page.server';
import { createDocument } from '$lib/data/records';
import { createDocument as createDocumentService } from '$lib/services';
import { CURRENT_USER } from '$lib/server/current-user';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { resolveRequestContext } from '$lib/server/request-context';

function loadEvent(id: string): Parameters<typeof load>[0] {
	return {
		params: { id },
		locals: { requestContext: resolveRequestContext() }
	} as unknown as Parameters<typeof load>[0];
}

describe('routes/doc/[id]/+page.server', () => {
	it('returns the document title for a document written directly to the default doc', () => {
		const { doc } = resolveWorkspaceContext();
		const docMeta = createDocument(doc, { title: 'My Doc' });

		const result = load(loadEvent(docMeta.id));

		// documents is routed through the service layer's listDocuments, which
		// still finds this uncataloged (raw-CRDT-written) document via its
		// catalog-plus-uncataloged-fallback union — not empty.
		expect(result).toEqual({
			documentId: docMeta.id,
			title: 'My Doc',
			documents: [expect.objectContaining({ id: docMeta.id, title: 'My Doc' })],
			collections: []
		});
	});

	it('resolves the title from a Document living in its own real shard (#120)', () => {
		const docMeta = createDocumentService(CURRENT_USER, { title: 'Sharded Doc' });

		const result = load(loadEvent(docMeta.id));

		expect(result).toEqual({
			documentId: docMeta.id,
			title: 'Sharded Doc',
			documents: [expect.objectContaining({ id: docMeta.id, title: 'Sharded Doc' })],
			collections: []
		});
	});

	it('falls back to "Untitled" for a nonexistent document', () => {
		const result = load(loadEvent('nonexistent'));
		expect(result).toEqual({
			documentId: 'nonexistent',
			title: 'Untitled',
			documents: [],
			collections: []
		});
	});
});
