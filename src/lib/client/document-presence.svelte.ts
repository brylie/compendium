import type { Awareness } from 'y-protocols/awareness';
import { SvelteMap } from 'svelte/reactivity';
import { actorKey, formatActor } from '$lib/data/format';
import type { ActorId } from '$lib/data/types';
import {
	claimBlockPresence,
	releaseBlockPresence,
	subscribeHeldByOthers
} from '$lib/client/presence';

// Toggled onto holdAnnouncement below to guarantee a screen reader
// re-announces it even when two consecutive, distinct transitions
// happen to produce identical wording — a live region only re-fires on
// an actual text change, and this doesn't affect what's read aloud.
export const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/**
 * Owns the Document editor's collaborative hold and presence wiring (issue #18/#241/#298).
 * Tracks blocks held by other actors, publishes screen-reader announcements on transitions,
 * and manages implicit presence claims across shard awareness instances.
 */
export function createDocumentPresence() {
	const heldByOthers = new SvelteMap<string, ActorId>();
	let holdAnnouncement = $state('');
	let lastPresenceAwareness: Awareness | undefined;

	/**
	 * Claims implicit presence for `presenceBlockId` on `presenceAwareness`.
	 * Releases any hold on a previous Awareness connection first when switching shards (#242).
	 */
	function claim(presenceAwareness: Awareness, presenceBlockId: string): void {
		if (lastPresenceAwareness && lastPresenceAwareness !== presenceAwareness) {
			releaseBlockPresence(lastPresenceAwareness);
		}
		claimBlockPresence(presenceAwareness, presenceBlockId);
		lastPresenceAwareness = presenceAwareness;
	}

	/** Clears this client's implicit presence hold on whichever Awareness instance held it. */
	function release(): void {
		if (lastPresenceAwareness) {
			releaseBlockPresence(lastPresenceAwareness);
			lastPresenceAwareness = undefined;
		}
	}

	/**
	 * Subscribes to other actors' block holds on `docAwareness` and manages screen-reader announcements.
	 * Returns a cleanup function that unsubscribes and releases this client's hold.
	 */
	function connect(docAwareness: Awareness): () => void {
		holdAnnouncement = '';
		let previousHeldByOthers: Map<string, ActorId> = new SvelteMap();
		// The subscription's first callback reports presence as of connect
		// time, not a transition — without this, every actor who was
		// already editing before this client joined gets misreported as
		// having "just started".
		let isFirstSnapshot = true;
		let announceToggle = false;

		const unsubscribePresence = subscribeHeldByOthers(docAwareness, (held) => {
			const messages: string[] = [];
			for (const [recordId, actor] of held) {
				const previousActor = previousHeldByOthers.get(recordId);
				if (!previousActor) {
					if (!isFirstSnapshot) {
						messages.push(`${formatActor(actor)} started editing a block`);
					}
				} else if (actorKey(previousActor) !== actorKey(actor)) {
					// One actor released this block and another claimed it
					// in the same update — both halves of that handoff need
					// announcing, not just a silent no-op because the
					// record id itself never left the map.
					messages.push(`${formatActor(previousActor)} finished editing a block`);
					messages.push(`${formatActor(actor)} started editing a block`);
				}
			}
			for (const [recordId, actor] of previousHeldByOthers) {
				if (!held.has(recordId)) {
					messages.push(`${formatActor(actor)} finished editing a block`);
				}
			}
			if (messages.length > 0) {
				announceToggle = !announceToggle;
				holdAnnouncement = (announceToggle ? ZERO_WIDTH_SPACE : '') + messages.join('; ');
			}
			previousHeldByOthers = held;
			isFirstSnapshot = false;
			heldByOthers.clear();
			for (const [recordId, actor] of held) {
				heldByOthers.set(recordId, actor);
			}
		});

		return () => {
			unsubscribePresence();
			releaseBlockPresence(docAwareness);
			if (lastPresenceAwareness && lastPresenceAwareness !== docAwareness) {
				releaseBlockPresence(lastPresenceAwareness);
			}
			lastPresenceAwareness = undefined;
			heldByOthers.clear();
		};
	}

	return {
		get heldByOthers() {
			return heldByOthers;
		},
		get holdAnnouncement() {
			return holdAnnouncement;
		},
		claim,
		release,
		connect
	};
}
