import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import {
	aggregateHolds,
	clientIdForToken,
	initHoldEviction,
	isHeldByClient,
	releaseAgentHold,
	requestAgentHold,
	resetHoldsForTests
} from './holds';
import type { ActorId } from '$lib/data/types';

const agent: ActorId = { kind: 'agent', agentId: 'a1', name: 'Research Agent' };
const human: ActorId = { kind: 'human', userId: 'brylie' };

const HUMAN_CLIENT_ID = 999;

function setHumanCursor(awareness: Awareness, recordId: string | null): void {
	// Simulates what the browser's own Awareness client does locally — a real
	// peer's local state, applied here via the same doc's awareness for test
	// simplicity (production has a distinct doc.clientID per browser tab).
	awareness.states.set(
		HUMAN_CLIENT_ID,
		recordId ? { actor: human, heldRecordIds: [recordId] } : {}
	);
	awareness.meta.set(HUMAN_CLIENT_ID, {
		clock: (awareness.meta.get(HUMAN_CLIENT_ID)?.clock ?? 0) + 1,
		lastUpdated: Date.now()
	});
	awareness.emit('change', [{ added: [], updated: [HUMAN_CLIENT_ID], removed: [] }, 'test']);
}

describe('holds: agent hold requests', () => {
	let doc: Y.Doc;
	let awareness: Awareness;

	beforeEach(() => {
		resetHoldsForTests();
		doc = new Y.Doc();
		awareness = new Awareness(doc);
		initHoldEviction(awareness);
	});

	afterEach(() => {
		awareness.destroy();
	});

	it('grants holds on unheld, permitted records', () => {
		const clientId = clientIdForToken('token-a');
		const result = requestAgentHold(awareness, clientId, agent, ['r1', 'r2'], () => true);
		expect(result).toEqual({ granted: ['r1', 'r2'], denied: [] });
		expect(isHeldByClient(awareness, clientId, 'r1')).toBe(true);
	});

	it('denies records failing the permission check, per-record (not all-or-nothing)', () => {
		const clientId = clientIdForToken('token-a');
		const result = requestAgentHold(awareness, clientId, agent, ['r1', 'r2'], (id) => id !== 'r2');
		expect(result).toEqual({ granted: ['r1'], denied: ['r2'] });
	});

	it('denies a record already held by another client', () => {
		const clientA = clientIdForToken('token-a');
		const clientB = clientIdForToken('token-b');
		requestAgentHold(awareness, clientA, agent, ['r1'], () => true);
		const result = requestAgentHold(awareness, clientB, agent, ['r1', 'r2'], () => true);
		expect(result).toEqual({ granted: ['r2'], denied: ['r1'] });
	});

	it('denies a hold request on a block a human cursor currently occupies', () => {
		setHumanCursor(awareness, 'r1');
		const clientId = clientIdForToken('token-a');
		const result = requestAgentHold(awareness, clientId, agent, ['r1', 'r2'], () => true);
		expect(result).toEqual({ granted: ['r2'], denied: ['r1'] });
	});

	it('a human cursor arriving after an agent hold evicts that block only, leaving the rest held', () => {
		const clientId = clientIdForToken('token-a');
		requestAgentHold(awareness, clientId, agent, ['r1', 'r2'], () => true);
		expect(isHeldByClient(awareness, clientId, 'r1')).toBe(true);

		setHumanCursor(awareness, 'r1');

		expect(isHeldByClient(awareness, clientId, 'r1')).toBe(false);
		expect(isHeldByClient(awareness, clientId, 'r2')).toBe(true);
	});

	it('release_records drops only the specified ids', () => {
		const clientId = clientIdForToken('token-a');
		requestAgentHold(awareness, clientId, agent, ['r1', 'r2'], () => true);
		releaseAgentHold(awareness, clientId, ['r1']);
		expect(isHeldByClient(awareness, clientId, 'r1')).toBe(false);
		expect(isHeldByClient(awareness, clientId, 'r2')).toBe(true);
	});

	it('aggregateHolds reflects current holders', () => {
		const clientId = clientIdForToken('token-a');
		requestAgentHold(awareness, clientId, agent, ['r1'], () => true);
		expect(aggregateHolds(awareness).get('r1')).toEqual(agent);
	});

	it('the same token always maps to the same synthetic clientID', () => {
		expect(clientIdForToken('token-a')).toBe(clientIdForToken('token-a'));
		expect(clientIdForToken('token-a')).not.toBe(clientIdForToken('token-b'));
	});

	it('permission revoked on an already-held record evicts it instead of renewing it', () => {
		const clientId = clientIdForToken('token-a');
		requestAgentHold(awareness, clientId, agent, ['r1', 'r2'], () => true);
		expect(isHeldByClient(awareness, clientId, 'r1')).toBe(true);

		const result = requestAgentHold(awareness, clientId, agent, ['r1'], () => false);

		expect(result).toEqual({ granted: [], denied: ['r1'] });
		expect(isHeldByClient(awareness, clientId, 'r1')).toBe(false);
		expect(isHeldByClient(awareness, clientId, 'r2')).toBe(true);
	});

	describe('TTL (AGENT_HOLD_TTL_MS = 100s)', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('auto-releases a hold at the 100s boundary, not before', () => {
			const clientId = clientIdForToken('token-a');
			requestAgentHold(awareness, clientId, agent, ['r1'], () => true);

			vi.advanceTimersByTime(99_999);
			expect(isHeldByClient(awareness, clientId, 'r1')).toBe(true);

			vi.advanceTimersByTime(1);
			expect(isHeldByClient(awareness, clientId, 'r1')).toBe(false);
		});

		it('re-requesting an already-held record resets the 100s window from the re-request, not the original grant', () => {
			const clientId = clientIdForToken('token-a');
			requestAgentHold(awareness, clientId, agent, ['r1'], () => true);

			vi.advanceTimersByTime(80_000);
			requestAgentHold(awareness, clientId, agent, ['r1'], () => true);

			vi.advanceTimersByTime(80_000); // 160s since the original grant, 80s since the renewal
			expect(isHeldByClient(awareness, clientId, 'r1')).toBe(true);

			vi.advanceTimersByTime(20_000); // 100s since the renewal
			expect(isHeldByClient(awareness, clientId, 'r1')).toBe(false);
		});
	});
});
