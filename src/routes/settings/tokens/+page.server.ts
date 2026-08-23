import { fail } from '@sveltejs/kit';
import { getYDoc } from '$lib/server/ydoc';
import { listCollections, listDocuments } from '$lib/data/records';
import { createToken, listTokens, revokeToken } from '$lib/mcp/tokens';
import { logAudit } from '$lib/server/audit';
import type { Actions, PageServerLoad } from './$types';

const CURRENT_USER = { kind: 'human', userId: 'local' } as const;

export const load: PageServerLoad = () => {
	const doc = getYDoc();
	return {
		tokens: listTokens(),
		documents: listDocuments(doc),
		collections: listCollections(doc)
	};
};

export const actions: Actions = {
	create: async ({ request }) => {
		const data = await request.formData();
		const clientLabel = String(data.get('clientLabel') ?? '').trim();
		if (!clientLabel) return fail(400, { error: 'Client label is required' });

		const allowedDocumentIds = data.getAll('documentIds').map(String);
		const allowedCollectionIds = data.getAll('collectionIds').map(String);

		const { token, record } = createToken({
			clientLabel,
			allowedDocumentIds,
			allowedCollectionIds
		});
		logAudit({ actor: CURRENT_USER, action: 'create_token', targetRecordId: record.tokenHash });

		return { createdToken: token, clientLabel };
	},
	revoke: async ({ request }) => {
		const data = await request.formData();
		const tokenHash = String(data.get('tokenHash') ?? '');
		if (!tokenHash) return fail(400, { error: 'Missing token' });
		revokeToken(tokenHash);
		logAudit({ actor: CURRENT_USER, action: 'revoke_token', targetRecordId: tokenHash });
		return { revoked: true };
	}
};
