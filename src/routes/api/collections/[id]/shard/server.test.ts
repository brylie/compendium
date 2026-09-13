import { describe, expect, it } from 'vitest';
import { GET } from './+server';
import { createCollection } from '$lib/services';
import { CURRENT_USER } from '$lib/server/current-user';
import { resolveRequestContext } from '$lib/server/request-context';

function shardRequest(id: string): Parameters<typeof GET>[0] {
	return {
		params: { id },
		locals: { requestContext: resolveRequestContext() }
	} as unknown as Parameters<typeof GET>[0];
}

describe('routes/api/collections/[id]/shard', () => {
	it('resolves the real shard for an existing Collection', async () => {
		const collection = createCollection(resolveRequestContext(CURRENT_USER), {
			title: 'Shard Test',
			schema: []
		});

		const response = await GET(shardRequest(collection.id));
		const data = await response.json();

		// createCollection assigns shardId === the collection's own id (#120).
		expect(data.shardId).toBe(collection.id);
	});

	it('falls back to the default shard for a nonexistent id', async () => {
		const response = await GET(shardRequest('nonexistent'));
		const data = await response.json();
		expect(data.shardId).toBe('default');
	});
});
