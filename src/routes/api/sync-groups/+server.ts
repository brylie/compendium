import { error, json } from '@sveltejs/kit';
import { resolveSyncGroups } from '$lib/services/synced-blocks';
import type { RequestHandler } from './$types';

// Comfortably above any real Document's own flattened block count (this
// route's actual candidate-id source, see +page.svelte) while still well
// under SQLite's own bound-parameter ceiling for the `IN (...)` query this
// feeds (listSyncedBlockInstancesAcrossShards) — a request past this is
// necessarily malformed/abusive input, not a legitimate Document view.
const MAX_RECORD_IDS = 2000;

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
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		error(400, 'Invalid JSON body');
	}
	const recordIds =
		body && typeof body === 'object' && Array.isArray((body as { recordIds?: unknown }).recordIds)
			? (body as { recordIds: unknown[] }).recordIds.filter(
					(id): id is string => typeof id === 'string'
				)
			: [];
	if (recordIds.length > MAX_RECORD_IDS) {
		error(400, `Too many recordIds (max ${MAX_RECORD_IDS})`);
	}
	return json(resolveSyncGroups(locals.requestContext, recordIds));
};
