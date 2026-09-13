import type { ActorId, ParentKind } from '$lib/data/types';
import type { RequestContext, Caller } from '$lib/server/request-context';
import type { WorkspaceContext } from '$lib/server/workspace-store';
import { getRecord, resolveOwningParentId } from '$lib/data/record-ops';
import { tokenAllowsParent, type AccessToken } from '$lib/server/token-store';
import { logAudit } from '$lib/server/audit';
import { resolveShardForParent, resolveShardForRecord } from '$lib/server/catalog';

export { resolveOwningParentId };

/** Same shape as `RequestContext`'s own `Caller` — re-exported here since every service function historically named it `CallerIdentity`. */
export type CallerIdentity = Caller;

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
 * Throws `PermissionDeniedError` (and logs a denial for token callers) unless `context.caller`'s
 * access token allows `parentId`, resolving through any Space-level grant in addition to
 * the per-ID allowlist. No-ops for the single-tenant UI's own local-user caller.
 */
export function requireAccessibleParent(
	context: RequestContext,
	parentId: string,
	action?: string
): void {
	const caller = context.caller;
	if (isAccessToken(caller)) {
		// Resolved for the token's Space-level grant (#6) — the per-ID
		// allowlist checks alone can't see a Space-wide grant, so a token
		// scoped only to a Space (never given this specific id directly)
		// would otherwise always fail here.
		const spaceId = resolveShardForParent(context.workspaceId, parentId)?.spaceId;
		if (!tokenAllowsParent(caller, parentId, spaceId)) {
			logDenial(caller, action, parentId);
			throw new PermissionDeniedError(`Not permitted to access parent ${parentId}`);
		}
	}
}

/**
 * Looks up `recordId` and throws `PermissionDeniedError` (logging a denial) if it doesn't
 * exist or its parent isn't accessible to `context.caller`; otherwise returns the record. A
 * record nested inside a container block (columns/column) is checked against its owning
 * Document's grant, not the container's own (non-catalog-navigable) id — see
 * resolveOwningParentId.
 */
export function requireAccessibleRecord(
	context: RequestContext,
	recordId: string,
	action?: string
): NonNullable<ReturnType<typeof getRecord>> {
	const { doc } = resolveRecordWorkspaceContext(context, recordId);
	const record = getRecord(doc, recordId);
	if (!record) {
		logDenial(context.caller, action, recordId);
		throw new PermissionDeniedError(`Record ${recordId} not found`);
	}
	requireAccessibleParent(context, resolveOwningParentId(doc, record.parentId), action);
	return record;
}

/**
 * Resolves the WorkspaceContext a Document/Collection — or, since issue
 * #148, a nested container record (a `columns`/`column` block) — actually
 * lives in, for callers that already have its own id (query_collection's
 * collectionId, create_record's parentId). See catalog.ts's
 * resolveShardForParent. A record-kind id isn't itself catalog-navigable
 * (§3.1), so it falls back to `resolveShardForRecord` — every record,
 * container or not, gets its own locator entry, either reserved by the
 * service layer at creation (services/records.ts#createRecord) or by
 * record-locator-observer.ts for a record created via direct UI mutation
 * (issue #253) — before finally falling back to the default context for the
 * rare case a locator is still genuinely missing (e.g. a shard resolved
 * before the observer/backfill existed and not yet reconciled).
 *
 * Resolves through `context.workspaceStore` rather than an ambient import,
 * so a caller with its own isolated store (a test, most notably) never
 * silently resolves against the process-wide default (issue #306).
 */
export function resolveParentWorkspaceContext(
	context: RequestContext,
	parentId: string
): WorkspaceContext & { parentKind?: ParentKind; parentSpaceId?: string } {
	const { workspaceId, workspaceStore } = context;
	const shard = resolveShardForParent(workspaceId, parentId);
	if (shard) {
		const ctx = workspaceStore.resolve({ workspaceId, shardId: shard.shardId });
		return { ...ctx, parentKind: shard.kind, parentSpaceId: shard.spaceId };
	}
	const recordShard = resolveShardForRecord(workspaceId, parentId);
	if (recordShard) {
		const ctx = workspaceStore.resolve({ workspaceId, shardId: recordShard.shardId });
		return { ...ctx, parentKind: 'record' };
	}
	return { ...workspaceStore.resolve({ workspaceId }) };
}

/**
 * Resolves the WorkspaceContext a single record/row lives in, for callers
 * that only have a bare recordId (write_record, delete_record, get_record).
 * See catalog.ts's resolveShardForRecord.
 */
export function resolveRecordWorkspaceContext(
	context: RequestContext,
	recordId: string
): WorkspaceContext {
	const { workspaceId, workspaceStore } = context;
	const shard = resolveShardForRecord(workspaceId, recordId);
	return workspaceStore.resolve(shard ? { workspaceId, shardId: shard.shardId } : { workspaceId });
}

/** Groups recordIds by their resolved shard, for a hold/release call that may legitimately span more than one. */
export function groupRecordIdsByShard(
	context: RequestContext,
	recordIds: string[]
): Map<string, string[]> {
	const { workspaceId, workspace } = context;
	const defaultShardId = workspace.shardId;
	const groups = new Map<string, string[]>();
	for (const id of recordIds) {
		const shardId = resolveShardForRecord(workspaceId, id)?.shardId ?? defaultShardId;
		const list = groups.get(shardId);
		if (list) list.push(id);
		else groups.set(shardId, [id]);
	}
	return groups;
}
