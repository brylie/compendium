import { json } from '@sveltejs/kit';
import { createSpace } from '$lib/services';
import type { RequestHandler } from './$types';

/** Creates a Space from the posted name. */
export const POST: RequestHandler = async ({ request, locals }) => {
	const body = await request.json();
	const name = String(body.name ?? '').trim() || 'Untitled Space';

	const space = createSpace(locals.requestContext.caller, name);
	return json(space);
};
