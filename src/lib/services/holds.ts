import type { RequestContext } from '$lib/server/request-context';
import { clientIdForToken, releaseAgentHold, requestAgentHold } from '$lib/server/holds';
import { logAudit } from '$lib/server/audit';
import {
	actorForCaller,
	groupRecordIdsByShard,
	isAccessToken,
	requireAccessibleRecord,
	PermissionDeniedError
} from './permissions';

/**
 * Grants a hold on each of `recordIds` for `context.caller` — permission-checking a token
 * caller's grant per record (or record existence/accessibility for a human caller) — and
 * audits the result. Never all-or-nothing: some ids may be granted while others are denied.
 *
 * A single call can legitimately span more than one shard (a cross-document agent batch is
 * a stated acceptance criterion — see docs/specifications/collaboration.md), so recordIds
 * are grouped by their resolved shard and requestAgentHold runs once per shard's own
 * Awareness, merging results across Document and Collection shards.
 */
export function holdRecords(
	context: RequestContext,
	recordIds: string[]
): { granted: string[]; denied: string[] } {
	const caller = context.caller;
	const actor = actorForCaller(caller);

	let result: { granted: string[]; denied: string[] };

	if (isAccessToken(caller)) {
		const clientId = clientIdForToken(caller.tokenHash);
		const { workspaceId, workspaceStore } = context;
		const granted: string[] = [];
		const denied: string[] = [];
		const permissions = new Map<string, boolean>();
		const canHold = (id: string): boolean => {
			const cached = permissions.get(id);
			if (cached !== undefined) return cached;
			try {
				requireAccessibleRecord(context, id, 'hold_records');
				permissions.set(id, true);
				return true;
			} catch (error) {
				if (!(error instanceof PermissionDeniedError)) throw error;
				permissions.set(id, false);
				return false;
			}
		};
		// Contended records skip the hold engine's permission callback. Check them
		// here too, so every unauthorized request is audited exactly once per id.
		for (const id of recordIds) canHold(id);
		for (const [shardId, ids] of groupRecordIdsByShard(context, recordIds)) {
			const { awareness } = workspaceStore.resolve({ workspaceId, shardId });
			const groupResult = requestAgentHold(awareness, clientId, actor, ids, canHold);
			granted.push(...groupResult.granted);
			denied.push(...groupResult.denied);
		}
		result = { granted, denied };
	} else {
		// Human callers: check record existence and permission
		const granted: string[] = [];
		const denied: string[] = [];
		for (const id of recordIds) {
			try {
				requireAccessibleRecord(context, id);
				granted.push(id);
			} catch (error) {
				if (!(error instanceof PermissionDeniedError)) throw error;
				denied.push(id);
			}
		}
		result = { granted, denied };
	}

	logAudit({ actor, action: 'hold_records', diff: result });
	return result;
}

/**
 * Releases any holds a token caller holds on `recordIds` (grouped by resolved shard, one
 * `releaseAgentHold` call per shard's Awareness) and audits the release. No-ops the actual
 * release for human callers, who never hold via this mechanism, but still audits the call.
 */
export function releaseRecords(context: RequestContext, recordIds: string[]): void {
	const caller = context.caller;
	const actor = actorForCaller(caller);

	if (isAccessToken(caller)) {
		const clientId = clientIdForToken(caller.tokenHash);
		const { workspaceId, workspaceStore } = context;
		for (const [shardId, ids] of groupRecordIdsByShard(context, recordIds)) {
			const { awareness } = workspaceStore.resolve({ workspaceId, shardId });
			releaseAgentHold(awareness, clientId, ids);
		}
	}

	logAudit({ actor, action: 'release_records', diff: { recordIds } });
}
