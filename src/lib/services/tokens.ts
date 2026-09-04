import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { listSpaces } from '$lib/server/catalog';
import {
	createToken as storeCreateToken,
	listTokens as storeListTokens,
	revokeToken as storeRevokeToken,
	type AccessToken
} from '$lib/server/token-store';
import { logAudit } from '$lib/server/audit';
import { resolveInternalLinkTarget } from '$lib/data/links';
import { actorForCaller, resolveParentWorkspaceContext, type CallerIdentity } from './permissions';

/** Thrown when a token-creation request names a Space id that isn't a real Space in this workspace. */
export class UnknownSpaceError extends Error {
	constructor(spaceId: string) {
		super(`${spaceId} is not a Space in this workspace.`);
		this.name = 'UnknownSpaceError';
	}
}

/** Thrown when a token-creation request names a Document id that isn't a real, existing Document. */
export class UnknownDocumentError extends Error {
	constructor(documentId: string) {
		super(`${documentId} is not a Document in this workspace.`);
		this.name = 'UnknownDocumentError';
	}
}

/** Thrown when a token-creation request names a Collection id that isn't a real, existing Collection. */
export class UnknownCollectionError extends Error {
	constructor(collectionId: string) {
		super(`${collectionId} is not a Collection in this workspace.`);
		this.name = 'UnknownCollectionError';
	}
}

/**
 * Throws `new ErrorClass(id)` for the first `id` in `ids` that `existsFn` rejects — the shared
 * shape behind every one of `createToken`'s grant-existence checks (Space/Document/Collection
 * id lists), so "does every ID in this list exist" is answered once instead of reimplemented
 * per list (issue #62).
 */
function validateEvery(
	ids: string[],
	existsFn: (id: string) => boolean,
	ErrorClass: new (id: string) => Error
): void {
	for (const id of ids) {
		if (!existsFn(id)) throw new ErrorClass(id);
	}
}

/** A Document id naming a real, existing Document — a token grant needs no permission check of its own here (Phase 0 has no membership model gating who a caller may grant a *future* token access to), just existence and kind. */
function documentExists(id: string): boolean {
	const { doc } = resolveParentWorkspaceContext(id);
	return resolveInternalLinkTarget(doc, id)?.kind === 'document';
}

/** A Collection id naming a real, existing Collection — see {@link documentExists}. */
function collectionExists(id: string): boolean {
	const { doc } = resolveParentWorkspaceContext(id);
	return resolveInternalLinkTarget(doc, id)?.kind === 'collection';
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
 * "single-tenant, no membership model yet" posture. Every grant list — Spaces, Documents,
 * Collections — is validated against what actually exists before persisting: a crafted
 * request could otherwise grant a token access to an id that merely happens to exist
 * somewhere else, or one that doesn't exist at all, since a dead grant only becomes
 * apparent (never matching anything via `tokenAllowsParent`) rather than rejected up front.
 */
export function createToken(
	caller: CallerIdentity,
	input: CreateTokenInput
): { token: string; record: AccessToken } {
	const { workspaceId } = resolveWorkspaceContext();
	const actor = actorForCaller(caller);

	const knownSpaceIds = new Set(listSpaces(workspaceId).map((space) => space.id));
	validateEvery(input.allowedSpaceIds, (id) => knownSpaceIds.has(id), UnknownSpaceError);
	validateEvery(input.allowedDocumentIds, documentExists, UnknownDocumentError);
	validateEvery(input.allowedCollectionIds, collectionExists, UnknownCollectionError);

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
