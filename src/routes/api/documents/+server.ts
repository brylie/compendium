import { json } from '@sveltejs/kit';
import { createDocument } from '$lib/services';
import { CURRENT_USER } from '$lib/server/current-user';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const title = String(body.title ?? '').trim() || 'Untitled';
	const parentDocumentId = body.parentDocumentId ? String(body.parentDocumentId) : undefined;

	const document = createDocument(CURRENT_USER, {
		title,
		parentDocumentId,
		createInitialBlock: true
	});

	return json(document);
};
