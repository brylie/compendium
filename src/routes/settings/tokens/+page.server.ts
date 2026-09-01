import { fail } from '@sveltejs/kit';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { listCollections, listDocuments } from '$lib/data/records';
import { listSpaces } from '$lib/server/catalog';
import { createToken, listTokens, revokeToken } from '$lib/mcp/tokens';
import { logAudit } from '$lib/server/audit';
import type { Actions, PageServerLoad } from './$types';

const CURRENT_USER = { kind: 'human', userId: 'local' } as const;

export const load: PageServerLoad = () => {
	const { doc, workspaceId } = resolveWorkspaceContext();
	return {
		tokens: listTokens(),
		documents: listDocuments(doc),
		collections: listCollections(doc),
		spaces: listSpaces(workspaceId)
	};
};

export const actions: Actions = {
	create: async ({ request }) => {
		const data = await request.formData();
		const clientLabel = String(data.get('clientLabel') ?? '').trim();
		if (!clientLabel) return fail(400, { error: 'Client label is required' });

		const allowedDocumentIds = data.getAll('documentIds').map(String);
		const allowedCollectionIds = data.getAll('collectionIds').map(String);
		const allowedSpaceIds = data.getAll('spaceIds').map(String);

		// spaceIds comes directly from the request — validate every submitted id
		// actually belongs to this workspace before it's persisted onto the
		// token, since Space membership later authorizes access on its own
		// (tokenAllowsParent). A crafted request could otherwise grant a token
		// access to a Space id that merely happens to exist somewhere.
		const { workspaceId } = resolveWorkspaceContext();
		const knownSpaceIds = new Set(listSpaces(workspaceId).map((space) => space.id));
		if (!allowedSpaceIds.every((spaceId) => knownSpaceIds.has(spaceId))) {
			return fail(400, { error: 'Invalid Space selection' });
		}

		const { token, record } = createToken({
			clientLabel,
			allowedDocumentIds,
			allowedCollectionIds,
			allowedSpaceIds
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
