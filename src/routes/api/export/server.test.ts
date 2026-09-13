import { describe, expect, it } from 'vitest';
import { GET } from './+server';
import { resolveRequestContext } from '$lib/server/request-context';
import { createDocument, createCollection } from '$lib/services';
import { CURRENT_USER } from '$lib/server/current-user';

function getRequest(params: Record<string, string>): Parameters<typeof GET>[0] {
	const searchParams = new URLSearchParams(params);
	return {
		url: new URL(`http://localhost/api/export?${searchParams.toString()}`),
		locals: { requestContext: resolveRequestContext() }
	} as unknown as Parameters<typeof GET>[0];
}

describe('routes/api/export', () => {
	it('exports full workspace zip by default', async () => {
		const response = await GET(getRequest({}));
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/zip');
		expect(response.headers.get('Content-Disposition')).toContain('workspace-export-');
	});

	it('exports single document as markdown', async () => {
		const doc = createDocument(CURRENT_USER, { title: 'Export Route Doc' });
		const response = await GET(getRequest({ scope: 'document', id: doc.id }));
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('text/markdown; charset=utf-8');
		expect(response.headers.get('Content-Disposition')).toContain('Export%20Route%20Doc.md');
	});

	it('exports collection as csv by default', async () => {
		const col = createCollection(CURRENT_USER, { title: 'Export Route Col', schema: [] });
		const response = await GET(getRequest({ scope: 'collection', id: col.id }));
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
		expect(response.headers.get('Content-Disposition')).toContain('Export%20Route%20Col.csv');
	});

	it('exports collection as json when format=json', async () => {
		const col = createCollection(CURRENT_USER, { title: 'Export Route Col JSON', schema: [] });
		const response = await GET(getRequest({ scope: 'collection', id: col.id, format: 'json' }));
		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
		expect(response.headers.get('Content-Disposition')).toContain(
			'Export%20Route%20Col%20JSON.json'
		);
	});

	it('returns 400 when requested document or collection does not exist', async () => {
		await expect(
			GET(getRequest({ scope: 'document', id: 'non-existent-doc' }))
		).rejects.toMatchObject({
			status: 400
		});
	});
});
