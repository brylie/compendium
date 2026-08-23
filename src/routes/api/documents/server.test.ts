import { describe, expect, it } from 'vitest';
import { POST } from './+server';

function jsonRequest(body: unknown): Parameters<typeof POST>[0] {
	return {
		request: new Request('http://localhost/api/documents', {
			method: 'POST',
			body: JSON.stringify(body)
		})
	} as Parameters<typeof POST>[0];
}

describe('routes/api/documents', () => {
	it('creates a document with the given title', async () => {
		const response = await POST(jsonRequest({ title: 'API Doc' }));
		const data = await response.json();
		expect(data.title).toBe('API Doc');
	});

	it('defaults to "Untitled" when no title is given', async () => {
		const response = await POST(jsonRequest({}));
		const data = await response.json();
		expect(data.title).toBe('Untitled');
	});

	it('nests under a parent when parentDocumentId is given', async () => {
		const parentRes = await POST(jsonRequest({ title: 'Parent' }));
		const parent = await parentRes.json();

		const childRes = await POST(jsonRequest({ title: 'Child', parentDocumentId: parent.id }));
		const child = await childRes.json();

		expect(child.parentDocumentId).toBe(parent.id);
	});
});
