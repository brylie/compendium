import { error, json } from '@sveltejs/kit';
import { createDocument, SpaceMismatchError } from '$lib/services';
import { UnknownSpaceError } from '$lib/server/catalog';
import type { RequestHandler } from './$types';

/** Creates a Document (with an initial block) from the posted title/parent, mapping an unknown or mismatched target Space into a 400 response. */
export const POST: RequestHandler = async ({ request, locals }) => {
	const body = await request.json();
	const title = String(body.title ?? '').trim() || 'Untitled';
	const parentDocumentId = body.parentDocumentId ? String(body.parentDocumentId) : undefined;
	const spaceId = body.spaceId ? String(body.spaceId) : undefined;

	try {
		const document = createDocument(locals.requestContext.caller, {
			title,
			parentDocumentId,
			createInitialBlock: true,
			spaceId
		});
		return json(document);
	} catch (err) {
		if (err instanceof UnknownSpaceError || err instanceof SpaceMismatchError) {
			error(400, err.message);
		}
		throw err;
	}
};
