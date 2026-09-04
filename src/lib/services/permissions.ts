import type { ActorId } from '$lib/data/types';
import { resolveWorkspaceContext, type WorkspaceContext } from '$lib/server/workspace-store';
import { getRecord } from '$lib/data/records';
import { tokenAllowsParent, type AccessToken } from '$lib/server/token-store';
import { logAudit } from '$lib/server/audit';
import { resolveShardForParent, resolveShardForRecord } from '$lib/server/catalog';

export type CallerIdentity = AccessToken | ActorId;

/** Thrown by the `require*` guards below when a caller isn't permitted to access a parent or record. */
export class PermissionDeniedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PermissionDeniedError';
	}
}

/** Type guard distinguishing an MCP access-token caller from a local human `ActorId` caller. */
export function isAccessToken(caller: CallerIdentity): caller is AccessToken {
	// CallerIdentity's own type never includes null, so sonarjs sees this as
	// an always-true comparison — but this guard runs at the MCP trust
	// boundary (see permissions.ts's role in service-layer.md), where a
	// caller can violate its declared type at runtime. `typeof null ===
	// 'object'` is true in JS, so this null check is load-bearing, not dead
	// code: keep it.
	// eslint-disable-next-line sonarjs/different-types-comparison
	return typeof caller === 'object' && caller !== null && 'tokenHash' in caller;
}

/** Normalizes a `CallerIdentity` to the `ActorId` used for audit attribution, mapping an access-token caller to a synthetic human-via-client actor. */
export function actorForCaller(caller: CallerIdentity): ActorId {
	if (isAccessToken(caller)) {
		return { kind: 'human-via-client', userId: 'local', client: caller.clientLabel };
	}
	return caller;
}

// `action` names a denial for the audit trail (docs/specifications/audit-coverage.md
// §3) — a trust log that only records successes misses exactly the events most
// relevant to trust (an agent repeatedly probing something it isn't granted).
// Gated to token callers: the single-tenant UI's own CURRENT_USER is never
// denied by these checks (requireAccessibleParent no-ops for it already), so
// there's nothing meaningful to log on that path.
function logDenial(
	caller: CallerIdentity,
	action: string | undefined,
	targetRecordId: string
): void {
	if (!action || !isAccessToken(caller)) return;
	logAudit({ actor: actorForCaller(caller), action: `${action}_denied`, targetRecordId });
}

/**
 * Throws `PermissionDeniedError` (and logs a denial for token callers) unless `caller`'s
 * access token allows `parentId`, resolving through any Space-level grant in addition to
 * the per-ID allowlist. No-ops for the single-tenant UI's own local-user caller.
 */
export function requireAccessibleParent(
	caller: CallerIdentity,
	parentId: string,
	action?: string
): void {
	if (isAccessToken(caller)) {
		// Resolved for the token's Space-level grant (#6) — the per-ID
		// allowlist checks alone can't see a Space-wide grant, so a token
		// scoped only to a Space (never given this specific id directly)
		// would otherwise always fail here.
		const { workspaceId } = resolveWorkspaceContext();
		const spaceId = resolveShardForParent(workspaceId, parentId)?.spaceId;
		if (!tokenAllowsParent(caller, parentId, spaceId)) {
			logDenial(caller, action, parentId);
			throw new PermissionDeniedError(`Not permitted to access parent ${parentId}`);
		}
	}
}

/**
 * Looks up `recordId` and throws `PermissionDeniedError` (logging a denial) if it doesn't
 * exist or its parent isn't accessible to `caller`; otherwise returns the record.
 */
export function requireAccessibleRecord(
	caller: CallerIdentity,
	recordId: string,
	action?: string
): NonNullable<ReturnType<typeof getRecord>> {
	const { doc } = resolveRecordWorkspaceContext(recordId);
	const record = getRecord(doc, recordId);
	if (!record) {
		logDenial(caller, action, recordId);
		throw new PermissionDeniedError(`Record ${recordId} not found`);
	}
	requireAccessibleParent(caller, record.parentId, action);
	return record;
}

/**
 * Resolves the WorkspaceContext a Document/Collection actually lives in,
 * for callers that already have its own id (query_collection's
 * collectionId, create_record's parentId) — see catalog.ts's
 * resolveShardForParent. Falls back to the default context when untracked
 * (content written directly to the Y.Doc, bypassing the service layer and
 * therefore the locator).
 */
export function resolveParentWorkspaceContext(
	parentId: string
): WorkspaceContext & { parentKind?: 'document' | 'collection'; parentSpaceId?: string } {
	const { workspaceId } = resolveWorkspaceContext();
	const shard = resolveShardForParent(workspaceId, parentId);
	const ctx = resolveWorkspaceContext(
		shard ? { workspaceId, shardId: shard.shardId } : { workspaceId }
	);
	return { ...ctx, parentKind: shard?.kind, parentSpaceId: shard?.spaceId };
}

/**
 * Resolves the WorkspaceContext a single record/row lives in, for callers
 * that only have a bare recordId (write_record, delete_record, get_record).
 * See catalog.ts's resolveShardForRecord.
 */
export function resolveRecordWorkspaceContext(recordId: string): WorkspaceContext {
	const { workspaceId } = resolveWorkspaceContext();
	const shard = resolveShardForRecord(workspaceId, recordId);
	return resolveWorkspaceContext(shard ? { workspaceId, shardId: shard.shardId } : { workspaceId });
}

/** Groups recordIds by their resolved shard, for a hold/release call that may legitimately span more than one. */
export function groupRecordIdsByShard(recordIds: string[]): Map<string, string[]> {
	const { workspaceId, shardId: defaultShardId } = resolveWorkspaceContext();
	const groups = new Map<string, string[]>();
	for (const id of recordIds) {
		const shardId = resolveShardForRecord(workspaceId, id)?.shardId ?? defaultShardId;
		const list = groups.get(shardId);
		if (list) list.push(id);
		else groups.set(shardId, [id]);
	}
	return groups;
}
