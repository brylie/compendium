import { getInstanceWorkspaceId } from './instance.js';
import { listSpaces } from './catalog.js';
import { resolveWorkspaceContext } from './workspace-store.js';
import { CURRENT_USER } from './current-user.js';
import type { AccessToken } from '../mcp/tokens.js';
import type { ActorId } from '../data/types.js';

// Who a boundary call is acting as — an access token (MCP) or a plain human
// actor (UI, Phase 0's one CURRENT_USER). Deliberately the same shape as
// services/permissions.ts's CallerIdentity rather than a new "Principal"
// type: Phase 0 has exactly one real caller, and introducing a second
// representation of "who's calling" alongside the one every service
// function already takes would add a translation step, not remove one.
export type Caller = AccessToken | ActorId;

/**
 * The trusted context every boundary (route load/action, API handler, MCP
 * request, WebSocket upgrade) resolves once from server-owned configuration
 * — never from a client-supplied value (#111 §111, #138). `workspaceId`
 * comes from `getInstanceWorkspaceId()`, not a route param or room name;
 * `allowedSpaceIds` is every Space in that workspace, since Phase 0's one
 * local principal may access all of them (no membership/grant model exists
 * yet) — the seam is here so a later, real per-principal restriction only
 * ever changes what `resolveRequestContext()` computes, not any of its
 * callers.
 */
export interface RequestContext {
	instanceId: string;
	workspaceId: string;
	caller: Caller;
	allowedSpaceIds: ReadonlySet<string>;
}

/** Resolves the trusted {@link RequestContext} for one boundary call, defaulting to Phase 0's single local user. */
export function resolveRequestContext(caller: Caller = CURRENT_USER): RequestContext {
	const workspaceId = getInstanceWorkspaceId();
	// Guarantees the catalog/default-Space bootstrap has run for this
	// workspace before listing its Spaces — resolveRequestContext() may be
	// the very first thing a fresh boundary call does, before anything else
	// has touched resolveWorkspaceContext() for this workspaceId.
	resolveWorkspaceContext({ workspaceId });
	const allowedSpaceIds = new Set(listSpaces(workspaceId).map((space) => space.id));
	return {
		instanceId: workspaceId,
		workspaceId,
		caller,
		allowedSpaceIds
	};
}
