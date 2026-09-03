import { fail } from '@sveltejs/kit';
import { listCollections, listDocuments, listSpaces, listTokens } from '$lib/services';
import { createToken, revokeToken, UnknownSpaceError } from '$lib/services/tokens';
import { formString } from '$lib/server/form-data';
import type { Actions, PageServerLoad } from './$types';

/**
 * Loads existing access tokens plus every Document/Collection/Space so the token-management UI
 * can render its allowlist pickers.
 *
 * Routed through the service layer, not the bare CRDT primitives directly (#188): since
 * #113/#120, service-created Documents/Collections live in their own shards and are discovered
 * through the catalog plus shard-aware service queries, so a raw default-`Y.Doc` read would
 * silently omit normal current content from the grant picker. `listTokens` stays a plain,
 * policy-free lookup called directly, same precedent as `spaces.ts`'s `createSpace` comment.
 */
export const load: PageServerLoad = ({ locals }) => {
	return {
		tokens: listTokens(locals.requestContext.caller),
		documents: listDocuments(locals.requestContext.caller),
		collections: listCollections(locals.requestContext.caller),
		spaces: listSpaces(locals.requestContext.caller)
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const data = await request.formData();
		const clientLabel = formString(data.get('clientLabel')).trim();
		if (!clientLabel) return fail(400, { error: 'Client label is required' });

		const allowedDocumentIds = data.getAll('documentIds').map(String);
		const allowedCollectionIds = data.getAll('collectionIds').map(String);
		const allowedSpaceIds = data.getAll('spaceIds').map(String);

		let token: string;
		try {
			({ token } = createToken(locals.requestContext.caller, {
				clientLabel,
				allowedDocumentIds,
				allowedCollectionIds,
				allowedSpaceIds
			}));
		} catch (err) {
			if (err instanceof UnknownSpaceError) {
				return fail(400, { error: 'Invalid Space selection' });
			}
			throw err;
		}

		return { createdToken: token, clientLabel };
	},
	revoke: async ({ request, locals }) => {
		const data = await request.formData();
		const tokenHash = formString(data.get('tokenHash'));
		if (!tokenHash) return fail(400, { error: 'Missing token' });
		revokeToken(locals.requestContext.caller, tokenHash);
		return { revoked: true };
	}
};
