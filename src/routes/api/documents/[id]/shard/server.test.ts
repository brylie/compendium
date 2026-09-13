import { describe, expect, it } from 'vitest';
import { GET } from './+server';
import { createDocument } from '$lib/services';
import { CURRENT_USER } from '$lib/server/current-user';
import { resolveRequestContext } from '$lib/server/request-context';

function shardRequest(id: string): Parameters<typeof GET>[0] {
	return {
		params: { id },
		locals: { requestContext: resolveRequestContext() }
	} as unknown as Parameters<typeof GET>[0];
}

describe('routes/api/documents/[id]/shard', () => {
	it('resolves the real shard for an existing Document', async () => {
		const document = createDocument(resolveRequestContext(CURRENT_USER), { title: 'Shard Test' });

		const response = await GET(shardRequest(document.id));
		const data = await response.json();

		// createDocument assigns shardId === the document's own id (#120).
		expect(data.shardId).toBe(document.id);
	});

	it('falls back to the default shard for a nonexistent id', async () => {
		const response = await GET(shardRequest('nonexistent'));
		const data = await response.json();
		expect(data.shardId).toBe('default');
	});
});
