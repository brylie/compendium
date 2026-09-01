import { queryAuditLog } from '$lib/server/audit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
	const actorKind = url.searchParams.get('actorKind') ?? undefined;
	const targetRecordId = url.searchParams.get('targetRecordId') ?? undefined;
	const entries = queryAuditLog({
		actorFilter: actorKind ? (actor) => actor.kind === actorKind : undefined,
		targetRecordId,
		limit: 200
	});
	return { entries, actorKind: actorKind ?? '', targetRecordId: targetRecordId ?? '' };
};
