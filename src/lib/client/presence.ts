import { getClientAwareness } from './yjs-client';
import { CURRENT_USER } from './actor';
import type { ActorId } from '$lib/data/types';

// A human's cursor in a block is itself an implicit hold under that human's
// identity (PRD) — published as this client's own Awareness local state.
// Moving focus to a different block immediately replaces the held set with
// just the new block, which both claims it and drops the old one; the
// server's per-block eviction (src/lib/server/holds.ts) takes care of
// releasing any agent hold that was sitting on the newly-focused block.

export function claimBlockPresence(blockId: string): void {
	getClientAwareness().setLocalState({ actor: CURRENT_USER, heldRecordIds: [blockId] });
}

export function releaseBlockPresence(): void {
	getClientAwareness().setLocalState({ actor: CURRENT_USER, heldRecordIds: [] });
}

/** Records held by anyone other than this browser tab — for placeholder rendering. */
export function subscribeHeldByOthers(onChange: (held: Map<string, ActorId>) => void): () => void {
	const awareness = getClientAwareness();

	const compute = (): void => {
		const held = new Map<string, ActorId>();
		awareness.getStates().forEach((state, clientId) => {
			if (clientId === awareness.clientID) return;
			const s = state as Partial<{ actor: ActorId; heldRecordIds: string[] }>;
			if (!s?.heldRecordIds || !s.actor) return;
			for (const id of s.heldRecordIds) {
				if (!held.has(id)) held.set(id, s.actor);
			}
		});
		onChange(held);
	};

	awareness.on('change', compute);
	compute();
	return () => awareness.off('change', compute);
}
