import { json } from '@sveltejs/kit';
import { getYDoc } from '$lib/server/ydoc';
import { createDocument, createRecord } from '$lib/data/records';
import { logAudit } from '$lib/server/audit';
import type { RequestHandler } from './$types';

const CURRENT_USER = { kind: 'human', userId: 'local' } as const;

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const title = String(body.title ?? '').trim() || 'Untitled';
	const parentDocumentId = body.parentDocumentId ? String(body.parentDocumentId) : undefined;

	const doc = getYDoc();
	const document = createDocument(doc, { title, parentDocumentId });
	createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, CURRENT_USER);
	logAudit({ actor: CURRENT_USER, action: 'create_document', targetRecordId: document.id });

	return json(document);
};
