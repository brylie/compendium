import { json } from '@sveltejs/kit';
import { createCollection } from '$lib/services';
import { CURRENT_USER } from '$lib/server/current-user';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const title = String(body.title ?? '').trim() || 'Untitled Collection';

	const collection = createCollection(CURRENT_USER, { title, schema: [] });
	return json(collection);
};
