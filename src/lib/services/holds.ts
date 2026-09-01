import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { clientIdForToken, releaseAgentHold, requestAgentHold } from '$lib/server/holds';
import { getRecord } from '$lib/data/records';
import { logAudit } from '$lib/server/audit';
import { tokenAllowsParent } from '$lib/mcp/tokens';
import { resolveShardForParent } from '$lib/server/catalog';
import {
	actorForCaller,
	groupRecordIdsByShard,
	isAccessToken,
	requireAccessibleRecord,
	type CallerIdentity
} from './permissions';

/**
 * Grants a hold on each of `recordIds` for `caller` — permission-checking a token caller's
 * grant per record (or record existence/accessibility for a human caller) — and audits the
 * result. Never all-or-nothing: some ids may be granted while others are denied.
 *
 * A single call can legitimately span more than one shard (a cross-document agent batch is
 * a stated acceptance criterion — see docs/specifications/collaboration.md), so recordIds
 * are grouped by their resolved shard and requestAgentHold runs once per shard's own
 * Awareness, merging results. In production every group resolves to the same default shard
 * today (#120 hasn't cut over shard assignment yet), so this is a no-op split until it does.
 */
export function holdRecords(
	caller: CallerIdentity,
	recordIds: string[]
): { granted: string[]; denied: string[] } {
	const actor = actorForCaller(caller);

	let result: { granted: string[]; denied: string[] };

	if (isAccessToken(caller)) {
		const clientId = clientIdForToken(caller.tokenHash);
		const { workspaceId } = resolveWorkspaceContext();
		const granted: string[] = [];
		const denied: string[] = [];
		for (const [shardId, ids] of groupRecordIdsByShard(recordIds)) {
			const { doc, awareness } = resolveWorkspaceContext({ workspaceId, shardId });
			const groupResult = requestAgentHold(awareness, clientId, actor, ids, (id) => {
				const record = getRecord(doc, id);
				if (!record) return false;
				const spaceId = resolveShardForParent(workspaceId, record.parentId)?.spaceId;
				return tokenAllowsParent(caller, record.parentId, spaceId);
			});
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
				requireAccessibleRecord(caller, id);
				granted.push(id);
			} catch {
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
export function releaseRecords(caller: CallerIdentity, recordIds: string[]): void {
	const actor = actorForCaller(caller);

	if (isAccessToken(caller)) {
		const clientId = clientIdForToken(caller.tokenHash);
		const { workspaceId } = resolveWorkspaceContext();
		for (const [shardId, ids] of groupRecordIdsByShard(recordIds)) {
			const { awareness } = resolveWorkspaceContext({ workspaceId, shardId });
			releaseAgentHold(awareness, clientId, ids);
		}
	}

	logAudit({ actor, action: 'release_records', diff: { recordIds } });
}
