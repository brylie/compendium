import { json } from '@sveltejs/kit';
import { resolveParentWorkspaceContext } from '$lib/services/permissions';
import type { RequestHandler } from './$types';

/**
 * The one lookup every client-side Document-content view (doc/[id], Sidebar
 * — see #120) makes before connecting its Yjs WebSocket: the client never
 * assumes shardId === documentId, since a pre-existing Document (created
 * before the shard-assignment cutover) still resolves to the default shard.
 */
export const GET: RequestHandler = ({ params }) => {
	const { shardId } = resolveParentWorkspaceContext(params.id);
	return json({ shardId });
};
