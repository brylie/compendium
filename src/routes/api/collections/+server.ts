import { error, json } from '@sveltejs/kit';
import { createCollection, DuplicateCollectionTitleError } from '$lib/services';
import { UnknownSpaceError } from '$lib/server/catalog';
import type { RequestHandler } from './$types';

/** Creates an empty-schema Collection from the posted title (and optional spaceId), mapping an unknown target Space or a title collision (issue #78: Collection titles are unique per-Space) into a 400 response. */
export const POST: RequestHandler = async ({ request, locals }) => {
	const body = await request.json();
	const title = String(body.title ?? '').trim() || 'Untitled Collection';
	const spaceId = body.spaceId ? String(body.spaceId) : undefined;

	try {
		const collection = createCollection(locals.requestContext.caller, {
			title,
			schema: [],
			spaceId
		});
		return json(collection);
	} catch (err) {
		if (err instanceof UnknownSpaceError || err instanceof DuplicateCollectionTitleError) {
			error(400, err.message);
		}
		throw err;
	}
};
