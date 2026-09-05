import { describe, expect, it } from 'vitest';
import { POST } from './+server';
import { resolveRequestContext } from '$lib/server/request-context';

function jsonRequest(body: unknown): Parameters<typeof POST>[0] {
	return {
		request: new Request('http://localhost/api/collections', {
			method: 'POST',
			body: JSON.stringify(body)
		}),
		locals: { requestContext: resolveRequestContext() }
	} as unknown as Parameters<typeof POST>[0];
}

describe('routes/api/collections', () => {
	it('creates a collection with the given title', async () => {
		const response = await POST(jsonRequest({ title: 'API Table' }));
		const data = await response.json();
		expect(data.title).toBe('API Table');
	});

	it('defaults to "Untitled Collection" when no title is given', async () => {
		const response = await POST(jsonRequest({}));
		const data = await response.json();
		expect(data.title).toBe('Untitled Collection');
	});

	it('returns a 400 error when the title collides with an existing Collection in the same Space (issue #78)', async () => {
		await POST(jsonRequest({ title: 'Sprint Tasks' }));
		await expect(POST(jsonRequest({ title: 'Sprint Tasks' }))).rejects.toMatchObject({
			status: 400
		});
	});
});
