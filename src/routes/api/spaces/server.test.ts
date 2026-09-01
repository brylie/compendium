import { describe, expect, it } from 'vitest';
import { POST } from './+server';
import { resolveRequestContext } from '$lib/server/request-context';
import { isKnownSpace } from '$lib/server/catalog';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';

function jsonRequest(body: unknown): Parameters<typeof POST>[0] {
	return {
		request: new Request('http://localhost/api/spaces', {
			method: 'POST',
			body: JSON.stringify(body)
		}),
		locals: { requestContext: resolveRequestContext() }
	} as unknown as Parameters<typeof POST>[0];
}

describe('routes/api/spaces', () => {
	it('creates a Space with the given name', async () => {
		const response = await POST(jsonRequest({ name: 'API Space' }));
		const data = await response.json();
		expect(data.name).toBe('API Space');

		const { workspaceId } = resolveWorkspaceContext();
		expect(isKnownSpace(workspaceId, data.id)).toBe(true);
	});

	it('defaults to "Untitled Space" when no name is given', async () => {
		const response = await POST(jsonRequest({}));
		const data = await response.json();
		expect(data.name).toBe('Untitled Space');
	});

	it('trims whitespace-only names to the default', async () => {
		const response = await POST(jsonRequest({ name: '   ' }));
		const data = await response.json();
		expect(data.name).toBe('Untitled Space');
	});
});
