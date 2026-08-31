import type { ActorId } from '$lib/data/types';
import { resolveWorkspaceContext, type WorkspaceContext } from '$lib/server/workspace-store';
import { getRecord } from '$lib/data/records';
import { tokenAllowsParent, type AccessToken } from '$lib/mcp/tokens';
import { logAudit } from '$lib/server/audit';
import { resolveShardForParent, resolveShardForRecord } from '$lib/server/catalog';

export type CallerIdentity = AccessToken | ActorId;

export class PermissionDeniedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PermissionDeniedError';
	}
}

export function isAccessToken(caller: CallerIdentity): caller is AccessToken {
	return typeof caller === 'object' && caller !== null && 'tokenHash' in caller;
}

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

export function requireAccessibleParent(
	caller: CallerIdentity,
	parentId: string,
	action?: string
): void {
	if (isAccessToken(caller)) {
		if (!tokenAllowsParent(caller, parentId)) {
			logDenial(caller, action, parentId);
			throw new PermissionDeniedError(`Not permitted to access parent ${parentId}`);
		}
	}
}

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
): WorkspaceContext & { parentKind?: 'document' | 'collection' } {
	const { workspaceId } = resolveWorkspaceContext();
	const shard = resolveShardForParent(workspaceId, parentId);
	const ctx = resolveWorkspaceContext(
		shard ? { workspaceId, shardId: shard.shardId } : { workspaceId }
	);
	return { ...ctx, parentKind: shard?.kind };
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
