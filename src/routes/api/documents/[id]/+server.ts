import { json } from '@sveltejs/kit';
import { deleteDocument } from '$lib/services';
import type { RequestHandler } from './$types';

/**
 * Deletes a Document via the service layer rather than the raw data/records.ts
 * primitive. Documents have their own shard since #120 — deleting one against
 * the browser's shared 'workspace' doc (as Sidebar.svelte used to) would target
 * the wrong doc entirely. Routing through the service layer deletes its full
 * descendant subtree from each of their real shards and keeps the catalog in
 * sync (see services/documents.ts's deleteDocument).
 */
export const DELETE: RequestHandler = ({ params, locals }) => {
	deleteDocument(locals.requestContext.caller, params.id);
	return json({ success: true });
};
