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

	it('aggregateHolds keeps the first holder found for a record two independent peers both claim', () => {
		// Two distinct local Awareness states both claiming the same record —
		// only reachable outside the eviction-aware requestAgentHold path (e.g.
		// two peers' states briefly overlapping mid-sync) — must not overwrite
		// the first holder found, matching this function's own "first found
		// wins" contract.
		awareness.states.set(111, { actor: human, heldRecordIds: ['r1'] });
		awareness.states.set(222, { actor: agent, heldRecordIds: ['r1'] });

		expect(aggregateHolds(awareness).get('r1')).toEqual(human);
	});

	it('the same token always maps to the same synthetic clientID', () => {
		expect(clientIdForToken('token-a')).toBe(clientIdForToken('token-a'));
		expect(clientIdForToken('token-a')).not.toBe(clientIdForToken('token-b'));
	});

	it('permission revoked on an already-held record evicts it instead of renewing it', () => {
		const clientId = clientIdForToken('token-a');
		requestAgentHold(awareness, clientId, agent, ['r1', 'r2'], () => true);
		expect(isHeldByClient(awareness, clientId, 'r1')).toBe(true);

		const result = requestAgentHold(awareness, clientId, agent, ['r1'], (id) => id !== 'r1');

		expect(result).toEqual({ granted: [], denied: ['r1'] });
		expect(isHeldByClient(awareness, clientId, 'r1')).toBe(false);
		expect(isHeldByClient(awareness, clientId, 'r2')).toBe(true);
	});

	it('revokes an already-held record even when a later request omits it entirely', () => {
		const clientId = clientIdForToken('token-a');
		requestAgentHold(awareness, clientId, agent, ['r1', 'r2'], () => true);
		expect(isHeldByClient(awareness, clientId, 'r1')).toBe(true);
		expect(isHeldByClient(awareness, clientId, 'r2')).toBe(true);

		// r1's permission is revoked, but this next request is about a wholly
		// unrelated record — r1 must still be evicted, not silently renewed.
		const result = requestAgentHold(awareness, clientId, agent, ['r3'], (id) => id !== 'r1');

		expect(result).toEqual({ granted: ['r3'], denied: [] });
		expect(isHeldByClient(awareness, clientId, 'r1')).toBe(false);
		expect(isHeldByClient(awareness, clientId, 'r2')).toBe(true);
		expect(isHeldByClient(awareness, clientId, 'r3')).toBe(true);
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

	it('initHoldEviction is idempotent — a second call does not double-wire the listener', () => {
		expect(() => initHoldEviction(awareness)).not.toThrow();
		const clientId = clientIdForToken('token-a');
		requestAgentHold(awareness, clientId, agent, ['r1'], () => true);
		setHumanCursor(awareness, 'r1');
		expect(isHeldByClient(awareness, clientId, 'r1')).toBe(false);
	});

	it('releaseAgentHold is a no-op for a client with no recorded hold state', () => {
		const clientId = clientIdForToken('token-never-held');
		expect(() => releaseAgentHold(awareness, clientId, ['r1'])).not.toThrow();
		expect(isHeldByClient(awareness, clientId, 'r1')).toBe(false);
	});

	it('releaseAgentHold with no recordIds releases every record the client holds', () => {
		const clientId = clientIdForToken('token-a');
		requestAgentHold(awareness, clientId, agent, ['r1', 'r2'], () => true);
		releaseAgentHold(awareness, clientId);
		expect(isHeldByClient(awareness, clientId, 'r1')).toBe(false);
		expect(isHeldByClient(awareness, clientId, 'r2')).toBe(false);
	});
});

describe('holds: eviction wiring across multiple concurrent Awareness instances (#120)', () => {
	// workspace-store.ts can resolve more than one concurrent {workspaceId,
	// shardId} context in the same process — each with its own Awareness —
	// and calls initHoldEviction() on every one of them. A single
	// module-level "already wired" flag would only ever wire the first one,
	// leaving every subsequent shard's cross-client hold eviction silently
	// dead. This proves eviction works independently on a *second* instance
	// resolved after the first, without needing real Collection sharding.
	let docA: Y.Doc;
	let docB: Y.Doc;
	let awarenessA: Awareness;
	let awarenessB: Awareness;

	beforeEach(() => {
		resetHoldsForTests();
		docA = new Y.Doc();
		docB = new Y.Doc();
		awarenessA = new Awareness(docA);
		awarenessB = new Awareness(docB);
	});

	afterEach(() => {
		awarenessA.destroy();
		awarenessB.destroy();
	});

	it('wires eviction independently on every distinct Awareness instance, not just the first', () => {
		initHoldEviction(awarenessA);
		initHoldEviction(awarenessB);

		const clientId = clientIdForToken('token-a');
		requestAgentHold(awarenessA, clientId, agent, ['r1'], () => true);
		requestAgentHold(awarenessB, clientId, agent, ['r1'], () => true);
		expect(isHeldByClient(awarenessA, clientId, 'r1')).toBe(true);
		expect(isHeldByClient(awarenessB, clientId, 'r1')).toBe(true);

		setHumanCursor(awarenessA, 'r1');
		setHumanCursor(awarenessB, 'r1');

		expect(isHeldByClient(awarenessA, clientId, 'r1')).toBe(false);
		expect(isHeldByClient(awarenessB, clientId, 'r1')).toBe(false);
	});

	it('still wires the second instance even when the first was initialized long before it', () => {
		initHoldEviction(awarenessA);
		// Simulate real usage: awarenessB is only created/wired well after A.
		const clientId = clientIdForToken('token-a');
		requestAgentHold(awarenessA, clientId, agent, ['r1'], () => true);
		setHumanCursor(awarenessA, 'r1');
		expect(isHeldByClient(awarenessA, clientId, 'r1')).toBe(false);

		initHoldEviction(awarenessB);
		requestAgentHold(awarenessB, clientId, agent, ['r2'], () => true);
		setHumanCursor(awarenessB, 'r2');
		expect(isHeldByClient(awarenessB, clientId, 'r2')).toBe(false);
	});
});

describe('holds: TTL timers scoped per-Awareness, not by clientId alone (#120)', () => {
	// The same access token always maps to the same synthetic clientId,
	// regardless of which shard's Awareness it's holding records on — a
	// cross-shard agent hold batch (a stated acceptance criterion) can
	// legitimately hold under that same clientId on two different Awareness
	// instances at once. A TTL timer map keyed only by clientId would let
	// the second shard's scheduleTtl() silently cancel the first shard's
	// timer, so the first hold would never auto-expire.
	let docA: Y.Doc;
	let docB: Y.Doc;
	let awarenessA: Awareness;
	let awarenessB: Awareness;

	beforeEach(() => {
		resetHoldsForTests();
		docA = new Y.Doc();
		docB = new Y.Doc();
		awarenessA = new Awareness(docA);
		awarenessB = new Awareness(docB);
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		awarenessA.destroy();
		awarenessB.destroy();
	});

	it('a hold on one shard keeps its own TTL even after the same clientId schedules a hold on another shard', () => {
		const clientId = clientIdForToken('token-a');

		requestAgentHold(awarenessA, clientId, agent, ['r1'], () => true);
		vi.advanceTimersByTime(60_000);
		// Scheduling a second, later hold under the *same* clientId on a
		// *different* Awareness must not reset or cancel shard A's timer.
		requestAgentHold(awarenessB, clientId, agent, ['r2'], () => true);

		vi.advanceTimersByTime(39_999); // 99,999ms since A's grant
		expect(isHeldByClient(awarenessA, clientId, 'r1')).toBe(true);
		vi.advanceTimersByTime(1); // 100,000ms since A's grant
		expect(isHeldByClient(awarenessA, clientId, 'r1')).toBe(false);
	});

	it('both shards expire independently at their own 100s boundary', () => {
		const clientId = clientIdForToken('token-a');

		requestAgentHold(awarenessA, clientId, agent, ['r1'], () => true);
		vi.advanceTimersByTime(50_000);
		requestAgentHold(awarenessB, clientId, agent, ['r2'], () => true);

		vi.advanceTimersByTime(50_000); // 100,000ms since A, 50,000ms since B
		expect(isHeldByClient(awarenessA, clientId, 'r1')).toBe(false);
		expect(isHeldByClient(awarenessB, clientId, 'r2')).toBe(true);

		vi.advanceTimersByTime(50_000); // 100,000ms since B
		expect(isHeldByClient(awarenessB, clientId, 'r2')).toBe(false);
	});
});
