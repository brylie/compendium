import { json } from '@sveltejs/kit';
import { getYDoc } from '$lib/server/ydoc';
import { createCollection } from '$lib/data/records';
import { logAudit } from '$lib/server/audit';
import type { RequestHandler } from './$types';

const CURRENT_USER = { kind: 'human', userId: 'local' } as const;

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const title = String(body.title ?? '').trim() || 'Untitled Collection';

	const doc = getYDoc();
	const collection = createCollection(doc, { title, schema: [] });
	logAudit({ actor: CURRENT_USER, action: 'create_collection', targetRecordId: collection.id });

	return json(collection);
};
