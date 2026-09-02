import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_USER } from './actor';
import { claimBlockPresence, releaseBlockPresence, subscribeHeldByOthers } from './presence';
import type { ActorId } from '$lib/data/types';

class FakeAwareness {
	clientID = 1;
	private states = new Map<number, unknown>();
	private listeners: Array<() => void> = [];
	setLocalState(state: unknown): void {
		this.states.set(this.clientID, state);
		this.fire();
	}
	getStates(): Map<number, unknown> {
		return this.states;
	}
	on(_event: string, cb: () => void): void {
		this.listeners.push(cb);
	}
	off(_event: string, cb: () => void): void {
		this.listeners = this.listeners.filter((l) => l !== cb);
	}
	fire(): void {
		this.listeners.forEach((l) => l());
	}
	setRemoteState(clientId: number, state: unknown): void {
		this.states.set(clientId, state);
		this.fire();
	}
}

let fakeAwareness: FakeAwareness;

describe('presence: block holds via Awareness', () => {
	beforeEach(() => {
		fakeAwareness = new FakeAwareness();
	});

	it("claims a block as this browser tab's local state", () => {
		claimBlockPresence(fakeAwareness as never, 'r1');
		expect(fakeAwareness.getStates().get(fakeAwareness.clientID)).toEqual({
			actor: CURRENT_USER,
			heldRecordIds: ['r1']
		});
	});

	it('releases the block by clearing heldRecordIds', () => {
		claimBlockPresence(fakeAwareness as never, 'r1');
		releaseBlockPresence(fakeAwareness as never);
		expect(fakeAwareness.getStates().get(fakeAwareness.clientID)).toEqual({
			actor: CURRENT_USER,
			heldRecordIds: []
		});
	});

	it('reports records held by other clients, ignoring this tab and states with no hold', () => {
		const onChange = vi.fn();
		const unsubscribe = subscribeHeldByOthers(fakeAwareness as never, onChange);

		const other: ActorId = { kind: 'agent', agentId: 'a1', name: 'Bot' };
		fakeAwareness.setRemoteState(2, { actor: other, heldRecordIds: ['r2'] });
		fakeAwareness.setRemoteState(3, {}); // no heldRecordIds/actor -> ignored
		claimBlockPresence(fakeAwareness as never, 'r1'); // own state -> excluded from "others"

		const lastCall = onChange.mock.calls.at(-1)![0] as Map<string, ActorId>;
		expect(lastCall.get('r2')).toEqual(other);
		expect(lastCall.has('r1')).toBe(false);

		unsubscribe();
	});

	it('keeps only the first holder found for a record held by more than one client', () => {
		const onChange = vi.fn();
		const other1: ActorId = { kind: 'agent', agentId: 'a1', name: 'First' };
		const other2: ActorId = { kind: 'agent', agentId: 'a2', name: 'Second' };
		fakeAwareness.setRemoteState(2, { actor: other1, heldRecordIds: ['r9'] });
		subscribeHeldByOthers(fakeAwareness as never, onChange);
		fakeAwareness.setRemoteState(3, { actor: other2, heldRecordIds: ['r9'] });

		const lastCall = onChange.mock.calls.at(-1)![0] as Map<string, ActorId>;
		expect(lastCall.get('r9')).toEqual(other1);
	});

	it('stops notifying after unsubscribe', () => {
		const onChange = vi.fn();
		const unsubscribe = subscribeHeldByOthers(fakeAwareness as never, onChange);
		const callsAtSubscribe = onChange.mock.calls.length;

		unsubscribe();
		fakeAwareness.setRemoteState(4, {
			actor: { kind: 'human', userId: 'x' },
			heldRecordIds: ['r5']
		});

		expect(onChange.mock.calls).toHaveLength(callsAtSubscribe);
	});
});
