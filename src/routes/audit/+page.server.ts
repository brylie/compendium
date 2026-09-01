import { listAuditHistory } from '$lib/services';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
	const actorKind = url.searchParams.get('actorKind') ?? undefined;
	const hasTargetRecordScope = url.searchParams.has('targetRecordId');
	const targetRecordId = hasTargetRecordScope
		? (url.searchParams.get('targetRecordId') ?? '')
		: undefined;
	const entries = listAuditHistory({
		actorFilter: actorKind ? (actor) => actor.kind === actorKind : undefined,
		targetRecordId,
		limit: 200
	});
	return {
		entries,
		actorKind: actorKind ?? '',
		targetRecordId: targetRecordId ?? '',
		hasTargetRecordScope
	};
};
