import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import {
	createSpace as catalogCreateSpace,
	listSpaces as catalogListSpaces
} from '$lib/server/catalog';
import { logAudit } from '$lib/server/audit';
import type { SpaceMeta } from '$lib/data/types';
import { actorForCaller, type CallerIdentity } from './permissions';

/**
 * Creates a new Space in the caller's workspace — the service-layer wrapper
 * around catalog.ts's createSpace (permission check → mutate → audit, in one
 * place, per CLAUDE.md's service-layer rule). Phase 0 permission: any
 * authenticated caller may create a Space, matching createDocument's own
 * "single-tenant, no membership model yet" posture. Reading the Space list
 * (catalog.ts's listSpaces/isKnownSpace) is a plain, policy-free lookup —
 * called directly from routes, same precedent as audit.ts's queryAuditLog
 * and tokens.ts's listTokens.
 */
export function createSpace(caller: CallerIdentity, name: string): SpaceMeta {
	const { workspaceId } = resolveWorkspaceContext();
	const actor = actorForCaller(caller);

	const space = catalogCreateSpace(workspaceId, name);
	logAudit({ actor, action: 'create_space', targetRecordId: space.id });
	return space;
}

/** Returns the workspace's catalog Spaces through the application boundary. */
export function listSpaces(_caller: CallerIdentity): SpaceMeta[] {
	const { workspaceId } = resolveWorkspaceContext();
	return catalogListSpaces(workspaceId);
}
