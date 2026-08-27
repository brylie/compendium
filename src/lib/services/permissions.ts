import type { ActorId } from '$lib/data/types';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { getRecord } from '$lib/data/records';
import { tokenAllowsParent, type AccessToken } from '$lib/mcp/tokens';
import { logAudit } from '$lib/server/audit';

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
	const { doc } = resolveWorkspaceContext();
	const record = getRecord(doc, recordId);
	if (!record) {
		logDenial(caller, action, recordId);
		throw new PermissionDeniedError(`Record ${recordId} not found`);
	}
	requireAccessibleParent(caller, record.parentId, action);
	return record;
}
