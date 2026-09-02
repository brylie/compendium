import { json } from '@sveltejs/kit';
import { deleteCollection } from '$lib/services';
import type { RequestHandler } from './$types';

/**
 * Deletes a Collection via the service layer rather than the raw data/records.ts
 * primitive. Collections have their own shard since #120 — deleting one against
 * the browser's shared 'workspace' doc (as Sidebar.svelte used to) would target
 * the wrong doc entirely. Routing through the service layer deletes it from its
 * real shard and keeps the catalog in sync.
 */
export const DELETE: RequestHandler = ({ params, locals }) => {
	deleteCollection(locals.requestContext.caller, params.id);
	return json({ success: true });
};
