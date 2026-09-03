import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { listSpaces } from '$lib/server/catalog';
import {
	createToken as storeCreateToken,
	listTokens as storeListTokens,
	revokeToken as storeRevokeToken,
	type AccessToken
} from '$lib/server/token-store';
import { logAudit } from '$lib/server/audit';
import { actorForCaller, type CallerIdentity } from './permissions';

/** Thrown when a token-creation request names a Space id that isn't a real Space in this workspace. */
export class UnknownSpaceError extends Error {
	constructor(spaceId: string) {
		super(`${spaceId} is not a Space in this workspace.`);
		this.name = 'UnknownSpaceError';
	}
}

export interface CreateTokenInput {
	clientLabel: string;
	allowedDocumentIds: string[];
	allowedCollectionIds: string[];
	allowedSpaceIds: string[];
}

/**
 * Creates a new access token — the service-layer wrapper around `mcp/tokens.ts`'s
 * `createToken` (validate → mutate → audit, in one place, per `service-layer.md`).
 * Phase 0 permission: any caller may mint a token, matching `createSpace`/`createDocument`'s
 * "single-tenant, no membership model yet" posture. `allowedSpaceIds` is validated against the
 * workspace's real Spaces before persisting — a crafted request could otherwise grant a token
 * access to a Space id that merely happens to exist somewhere else, since Space membership
 * alone later authorizes access (`tokenAllowsParent`).
 */
export function createToken(
	caller: CallerIdentity,
	input: CreateTokenInput
): { token: string; record: AccessToken } {
	const { workspaceId } = resolveWorkspaceContext();
	const actor = actorForCaller(caller);

	const knownSpaceIds = new Set(listSpaces(workspaceId).map((space) => space.id));
	for (const spaceId of input.allowedSpaceIds) {
		if (!knownSpaceIds.has(spaceId)) throw new UnknownSpaceError(spaceId);
	}

	const result = storeCreateToken(input);
	logAudit({ actor, action: 'create_token', targetRecordId: result.record.tokenHash });
	return result;
}

/** Revokes an existing access token — the service-layer wrapper around `mcp/tokens.ts`'s `revokeToken` (mutate → audit). */
export function revokeToken(caller: CallerIdentity, tokenHash: string): void {
	const actor = actorForCaller(caller);
	storeRevokeToken(tokenHash);
	logAudit({ actor, action: 'revoke_token', targetRecordId: tokenHash });
}

/** Returns token metadata for the settings surface; raw token values are never persisted. */
export function listTokens(): AccessToken[] {
	return storeListTokens();
}
