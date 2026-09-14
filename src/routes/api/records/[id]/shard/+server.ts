import { json } from '@sveltejs/kit';
import { resolveRecordWorkspaceContext } from '$lib/services/permissions';
import type { RequestHandler } from './$types';

/**
 * The bare-recordId counterpart to GET /api/documents/[id]/shard and
 * /api/collections/[id]/shard (#242): the one lookup client-side synced_block
 * rendering makes before connecting to a target record's *own* shard, since a
 * synced_block's referencedRecordId is never assumed to live in the viewing
 * Document's own shard — see $lib/client/yjs-client's resolveRecordDoc.
 */
export const GET: RequestHandler = ({ params, locals }) => {
	const { shardId } = resolveRecordWorkspaceContext(locals.requestContext, params.id);
	return json({ shardId });
};
