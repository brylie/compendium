import { json } from '@sveltejs/kit';
import { createDocument } from '$lib/services';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
	const body = await request.json();
	const title = String(body.title ?? '').trim() || 'Untitled';
	const parentDocumentId = body.parentDocumentId ? String(body.parentDocumentId) : undefined;

	const document = createDocument(locals.requestContext.caller, {
		title,
		parentDocumentId,
		createInitialBlock: true
	});

	return json(document);
};
