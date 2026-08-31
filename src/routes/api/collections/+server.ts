import { json } from '@sveltejs/kit';
import { createCollection } from '$lib/services';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	const body = await request.json();
	const title = String(body.title ?? '').trim() || 'Untitled Collection';

	const collection = createCollection(locals.requestContext.caller, { title, schema: [] });
	return json(collection);
};
