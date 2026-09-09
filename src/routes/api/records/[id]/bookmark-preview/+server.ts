import { json } from '@sveltejs/kit';
import { refreshBookmarkMetadata } from '$lib/services';
import type { RequestHandler } from './$types';

/**
 * Triggers a bookmark block's server-side preview fetch (issue #155) via the
 * service layer, for the UI's own bookmark-creation/retry flow
 * (BookmarkBlock.svelte). The block itself is created/urled directly against
 * the browser's own Y.Doc (the same "direct UI mutation" pattern every other
 * block create uses — see audit-coverage.md), since only the actual outbound
 * fetch needs a server round trip; this route exists solely to run that
 * fetch under the service layer's permission-check/audit contract rather than
 * exposing $lib/server/link-preview.ts to the client bundle.
 *
 * `documentId` is required in the request body: a direct-UI-created bookmark
 * has no catalog locator of its own (unlike one created via MCP's
 * `create_record`), so the service layer needs the owning Document's id —
 * always locator-tracked — to resolve the correct shard. See
 * `refreshBookmarkMetadata`'s own doc comment (services/records.ts) for the
 * full explanation.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	const body = await request.json();
	const documentId = String(body.documentId ?? '');
	const record = await refreshBookmarkMetadata(locals.requestContext.caller, params.id, documentId);
	return json({ bookmarkMetadata: record.bookmarkMetadata });
};
