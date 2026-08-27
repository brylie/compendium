import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { clientIdForToken, releaseAgentHold, requestAgentHold } from '$lib/server/holds';
import { getRecord } from '$lib/data/records';
import { logAudit } from '$lib/server/audit';
import { tokenAllowsParent } from '$lib/mcp/tokens';
import {
	actorForCaller,
	isAccessToken,
	requireAccessibleRecord,
	type CallerIdentity
} from './permissions';

export function holdRecords(
	caller: CallerIdentity,
	recordIds: string[]
): { granted: string[]; denied: string[] } {
	const { doc, awareness } = resolveWorkspaceContext();
	const actor = actorForCaller(caller);

	let result: { granted: string[]; denied: string[] };

	if (isAccessToken(caller)) {
		const clientId = clientIdForToken(caller.tokenHash);
		result = requestAgentHold(awareness, clientId, actor, recordIds, (id) => {
			const record = getRecord(doc, id);
			return record ? tokenAllowsParent(caller, record.parentId) : false;
		});
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

export function releaseRecords(caller: CallerIdentity, recordIds: string[]): void {
	const { awareness } = resolveWorkspaceContext();
	const actor = actorForCaller(caller);

	if (isAccessToken(caller)) {
		const clientId = clientIdForToken(caller.tokenHash);
		releaseAgentHold(awareness, clientId, recordIds);
	}

	logAudit({ actor, action: 'release_records', diff: { recordIds } });
}
