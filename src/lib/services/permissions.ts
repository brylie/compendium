import type { ActorId } from '$lib/data/types';
import { getYDoc } from '$lib/server/ydoc';
import { getRecord } from '$lib/data/records';
import { tokenAllowsParent, type AccessToken } from '$lib/mcp/tokens';

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

export function requireAccessibleParent(caller: CallerIdentity, parentId: string): void {
	if (isAccessToken(caller)) {
		if (!tokenAllowsParent(caller, parentId)) {
			throw new PermissionDeniedError(`Not permitted to access parent ${parentId}`);
		}
	}
}

export function requireAccessibleRecord(
	caller: CallerIdentity,
	recordId: string
): NonNullable<ReturnType<typeof getRecord>> {
	const doc = getYDoc();
	const record = getRecord(doc, recordId);
	if (!record) {
		throw new PermissionDeniedError(`Record ${recordId} not found`);
	}
	requireAccessibleParent(caller, record.parentId);
	return record;
}
