import { json } from '@sveltejs/kit';
import { deleteCollection } from '$lib/services';
import type { RequestHandler } from './$types';

// Collections have their own shard since #120 — deleting one via the raw
// data/records.ts primitive against the browser's shared 'workspace' doc
// (as Sidebar.svelte used to) targets the wrong doc entirely once a
// Collection lives in its own shard. Routing through the service layer
// deletes it from its real shard and keeps the catalog in sync.
export const DELETE: RequestHandler = ({ params, locals }) => {
	deleteCollection(locals.requestContext.caller, params.id);
	return json({ success: true });
};
