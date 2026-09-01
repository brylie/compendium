import { error, json } from '@sveltejs/kit';
import { createDocument, SpaceMismatchError } from '$lib/services';
import { UnknownSpaceError } from '$lib/server/catalog';
import type { RequestHandler } from './$types';

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
