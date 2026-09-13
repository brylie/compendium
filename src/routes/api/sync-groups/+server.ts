import { json } from '@sveltejs/kit';
import { resolveSyncGroups } from '$lib/services/synced-blocks';
import type { RequestHandler } from './$types';

/**
 * Batched cross-shard "used in N places" lookup (#242): a client posts every
 * record id it might need a sync group for — a Document's own flattened
 * block ids, plus any synced_block's referencedRecordId among them — once
 * per Document view, rather than one request per block. See
 * services/synced-blocks.ts#resolveSyncGroups for what's actually resolved;
 * an id with nothing to report (the overwhelming majority of blocks) is
 * simply absent from the response.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const body: unknown = await request.json();
	const recordIds =
		body && typeof body === 'object' && Array.isArray((body as { recordIds?: unknown }).recordIds)
			? (body as { recordIds: unknown[] }).recordIds.filter(
					(id): id is string => typeof id === 'string'
				)
			: [];
	return json(resolveSyncGroups(locals.requestContext, recordIds));
};
