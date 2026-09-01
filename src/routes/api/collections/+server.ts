import { error, json } from '@sveltejs/kit';
import { createCollection } from '$lib/services';
import { UnknownSpaceError } from '$lib/server/catalog';
import type { RequestHandler } from './$types';

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
		if (err instanceof UnknownSpaceError) {
			error(400, err.message);
		}
		throw err;
	}
};
