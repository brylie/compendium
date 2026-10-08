import { describe, expect, it, vi } from 'vitest';
import type { Awareness } from 'y-protocols/awareness';
import type { ActorId } from '$lib/data/types';
import { createDocumentPresence, ZERO_WIDTH_SPACE } from './document-presence.svelte';

vi.mock('$lib/client/presence', () => ({
	claimBlockPresence: vi.fn(),
	releaseBlockPresence: vi.fn(),
	subscribeHeldByOthers: vi.fn()
}));

import {
	claimBlockPresence,
	releaseBlockPresence,
	subscribeHeldByOthers
} from '$lib/client/presence';

describe('document-presence.svelte', () => {
	it('tracks heldByOthers and formats transition announcements', () => {
		let onChange: (held: Map<string, ActorId>) => void = () => {};
		vi.mocked(subscribeHeldByOthers).mockImplementation((_awareness, cb) => {
			onChange = cb;
			return () => {};
		});

		const presence = createDocumentPresence();
		const fakeAwareness = {} as Awareness;
		presence.connect(fakeAwareness);

		// First snapshot is ignored for announcements
		onChange(new Map([['b1', { kind: 'agent', agentId: 'a1', name: 'Alice' }]]));
		expect(presence.holdAnnouncement).toBe('');
		expect(presence.heldByOthers.get('b1')).toEqual({
			kind: 'agent',
			agentId: 'a1',
			name: 'Alice'
		});

		// Transition: second user starts editing
		onChange(
			new Map([
				['b1', { kind: 'agent', agentId: 'a1', name: 'Alice' }],
				['b2', { kind: 'agent', agentId: 'bot1', name: 'Bob' }]
			])
		);
		expect(presence.holdAnnouncement).toBe(`${ZERO_WIDTH_SPACE}Bob started editing a block`);

		// Transition: Alice finishes editing
		onChange(new Map([['b2', { kind: 'agent', agentId: 'bot1', name: 'Bob' }]]));
		expect(presence.holdAnnouncement).toBe('Alice finished editing a block');
	});

	it('releases old awareness connection when switching awareness in claim()', () => {
		const presence = createDocumentPresence();
		const awareness1 = { clientID: 1 } as unknown as Awareness;
		const awareness2 = { clientID: 2 } as unknown as Awareness;

		presence.claim(awareness1, 'block-1');
		expect(claimBlockPresence).toHaveBeenCalledWith(awareness1, 'block-1');

		presence.claim(awareness2, 'block-2');
		expect(releaseBlockPresence).toHaveBeenCalledWith(awareness1);
		expect(claimBlockPresence).toHaveBeenCalledWith(awareness2, 'block-2');

		presence.release();
		expect(releaseBlockPresence).toHaveBeenCalledWith(awareness2);
	});
});
