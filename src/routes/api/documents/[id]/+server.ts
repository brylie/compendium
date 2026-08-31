import { json } from '@sveltejs/kit';
import { deleteDocument } from '$lib/services';
import { CURRENT_USER } from '$lib/server/current-user';
import type { RequestHandler } from './$types';

// Documents have their own shard since #120 — deleting one via the raw
// data/records.ts primitive against the browser's shared 'workspace' doc
// (as Sidebar.svelte used to) targets the wrong doc entirely once a
// Document lives in its own shard. Routing through the service layer
// deletes its full descendant subtree from each of their real shards and
// keeps the catalog in sync (see services/documents.ts's deleteDocument).
export const DELETE: RequestHandler = ({ params }) => {
	deleteDocument(CURRENT_USER, params.id);
	return json({ success: true });
};
