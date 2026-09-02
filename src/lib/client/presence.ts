import type { Awareness } from 'y-protocols/awareness';
import { CURRENT_USER } from './actor';
import type { ActorId } from '$lib/data/types';

// A human's cursor in a block is itself an implicit hold under that human's
// identity (PRD) — published as this client's own Awareness local state.
// Moving focus to a different block immediately replaces the held set with
// just the new block, which both claims it and drops the old one; the
// server's per-block eviction (src/lib/server/holds.ts) takes care of
// releasing any agent hold that was sitting on the newly-focused block.
//
// `awareness` is the caller's responsibility to resolve — a block's presence
// belongs to whichever shard's Awareness its own Document is connected to
// (#120: each Document has its own shard), not a single shared instance.

/** Publishes this client's cursor position in `blockId` as an implicit hold, replacing any block it previously held. */
export function claimBlockPresence(awareness: Awareness, blockId: string): void {
	awareness.setLocalState({ actor: CURRENT_USER, heldRecordIds: [blockId] });
}

/** Clears this client's implicit hold, e.g. when focus leaves the editor entirely. */
export function releaseBlockPresence(awareness: Awareness): void {
	awareness.setLocalState({ actor: CURRENT_USER, heldRecordIds: [] });
}

/** Records held by anyone other than this browser tab — for placeholder rendering. */
export function subscribeHeldByOthers(
	awareness: Awareness,
	onChange: (held: Map<string, ActorId>) => void
): () => void {
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
