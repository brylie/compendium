import type { Awareness } from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import type { ActorId } from '$lib/data/types';

// Holds are built on Yjs Awareness (docs/technical-design.md §4): ephemeral,
// per-client state that isn't part of document content. A browser tab is a
// real Awareness client (its own Yjs clientID, arriving over /ws). An MCP
// agent has no persistent connection in Phase 0 (HTTP transport, not a
// socket) — see §5 — so it's represented as a *synthetic* Awareness client,
// keyed deterministically off its access token so repeated hold_records /
// write_record / release_records calls from the same connection resolve to
// the same clientID without any server-side session table.

export interface HoldAwarenessState {
	actor: ActorId;
	heldRecordIds: string[];
}

const AGENT_HOLD_TTL_MS = 100_000; // PRD target: 90-120s

// Keyed by Awareness (not just clientId): the same synthetic clientId can now
// appear on multiple independent per-shard Awareness instances at once (#120),
// so a clientId-only key would let one shard's TTL timer/clock clobber
// another's for the same token. WeakMap also means a destroyed Awareness's
// entries aren't strongly retained for the process lifetime.
const agentClocks = new WeakMap<Awareness, Map<number, number>>();
const agentTtlTimers = new WeakMap<Awareness, Map<number, ReturnType<typeof setTimeout>>>();

// Per-Awareness-instance, not a single module-level flag: workspace-store.ts
// can resolve more than one concurrent {workspaceId, shardId} context (each
// with its own Awareness) — a single boolean guard would wire eviction only
// for whichever context happened to resolve first in the process, leaving
// every other shard's cross-client hold eviction silently dead.
let wiredAwareness = new WeakSet<Awareness>();

/** Stable synthetic clientID for a given access token, so a stateless HTTP
 *  agent's holds persist across separate hold/write/release calls. */
export function clientIdForToken(tokenHash: string): number {
	// FNV-1a 32-bit, kept in the same clientID space Yjs itself uses.
	let hash = 0x811c9dc5;
	for (let i = 0; i < tokenHash.length; i++) {
		hash ^= tokenHash.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	// Avoid clashing with the server's own awareness.clientID (a real Y.Doc
	// clientID) by offsetting into a distinct sub-range for synthetic ids.
	// (`| 0x80000000` would work bitwise but yields a *negative* JS number —
	// lib0's varint encoder assumes unsigned — so this uses addition instead.)
	return (hash >>> 1) + 0x80000000;
}

function readHoldState(awareness: Awareness, clientId: number): HoldAwarenessState | undefined {
	return awareness.getStates().get(clientId) as HoldAwarenessState | undefined;
}

/** Every currently held record, mapped to whoever holds it (first found wins;
 *  eviction below keeps this to at most one holder per record in practice). */
export function aggregateHolds(awareness: Awareness): Map<string, ActorId> {
	const held = new Map<string, ActorId>();
	awareness.getStates().forEach((state) => {
		const holdState = state as Partial<HoldAwarenessState> | undefined;
		if (!holdState?.heldRecordIds || !holdState.actor) return;
		for (const id of holdState.heldRecordIds) {
			if (!held.has(id)) held.set(id, holdState.actor);
		}
	});
	return held;
}

/**
 * Per-block exclusivity: whichever client most recently claimed a record ID
 * (human cursor arriving, or an agent's hold request) evicts that same ID
 * from every other client's hold set. This is what makes a human typing into
 * an agent-held block release that block specifically (PRD acceptance
 * criterion), symmetric with an agent's hold request being denied a block a
 * human's cursor already occupies.
 */
export function initHoldEviction(awareness: Awareness): void {
	if (wiredAwareness.has(awareness)) return;
	wiredAwareness.add(awareness);

	awareness.on(
		'change',
		({ added, updated }: { added: number[]; updated: number[]; removed: number[] }) => {
			const changedIds = added.concat(updated);
			for (const clientId of changedIds) {
				const state = readHoldState(awareness, clientId);
				if (!state?.heldRecordIds?.length) continue;
				for (const recordId of state.heldRecordIds) {
					evictFromOthers(awareness, recordId, clientId);
				}
			}
		}
	);
}

/** Test-only: clears the wired-Awareness registry so `initHoldEviction` can be re-wired against a fresh Awareness instance. */
export function resetHoldEvictionForTests(): void {
	wiredAwareness = new WeakSet<Awareness>();
	clearAllTestTimers();
}

function evictFromOthers(awareness: Awareness, recordId: string, exceptClientId: number): void {
	awareness.getStates().forEach((rawState, clientId) => {
		if (clientId === exceptClientId) return;
		const state = rawState as Partial<HoldAwarenessState> | undefined;
		if (!state?.heldRecordIds?.includes(recordId)) return;
		const nextHeld = state.heldRecordIds.filter((id) => id !== recordId);
		writeRemoteState(awareness, clientId, {
			...state,
			heldRecordIds: nextHeld
		} as HoldAwarenessState);
	});
}

function clocksFor(awareness: Awareness): Map<number, number> {
	let clocks = agentClocks.get(awareness);
	if (!clocks) {
		clocks = new Map();
		agentClocks.set(awareness, clocks);
	}
	return clocks;
}

function timersFor(awareness: Awareness): Map<number, ReturnType<typeof setTimeout>> {
	let timers = agentTtlTimers.get(awareness);
	if (!timers) {
		timers = new Map();
		agentTtlTimers.set(awareness, timers);
	}
	return timers;
}

// Test-only flat registry of every currently-scheduled timer, independent of
// which Awareness/clientId it belongs to — a WeakMap can't be enumerated, so
// resetHoldsForTests/resetHoldEvictionForTests need this side channel to
// cancel leftover timers between test runs.
const activeTestTimers = new Set<ReturnType<typeof setTimeout>>();

function clearAllTestTimers(): void {
	activeTestTimers.forEach((timer) => clearTimeout(timer));
	activeTestTimers.clear();
}

/** Directly injects/overwrites a (possibly synthetic) remote client's Awareness
 *  state — the same mechanism a real peer's update takes, just constructed
 *  server-side instead of decoded off the wire. */
function writeRemoteState(
	awareness: Awareness,
	clientId: number,
	state: HoldAwarenessState | null
): void {
	const clocks = clocksFor(awareness);
	const clock = (clocks.get(clientId) ?? 0) + 1;
	clocks.set(clientId, clock);

	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, 1);
	encoding.writeVarUint(encoder, clientId);
	encoding.writeVarUint(encoder, clock);
	encoding.writeVarString(encoder, JSON.stringify(state));
	awarenessProtocol.applyAwarenessUpdate(awareness, encoding.toUint8Array(encoder), 'server');
}

export interface HoldRequestResult {
	granted: string[];
	denied: string[];
}

/**
 * Grants or denies an agent's hold request per-record (never all-or-nothing):
 * a record already held by another client, or that fails `permissionCheck`,
 * is denied while the rest are granted. Also revalidates every record this
 * client already holds against `permissionCheck`, since permissions can
 * change between calls and a now-unauthorized hold must not silently persist.
 */
export function requestAgentHold(
	awareness: Awareness,
	clientId: number,
	actor: ActorId,
	recordIds: string[],
	permissionCheck: (recordId: string) => boolean
): HoldRequestResult {
	const currentlyHeld = aggregateHolds(awareness);
	const existing = readHoldState(awareness, clientId);
	const existingHeldIds = existing?.heldRecordIds ?? [];
	const granted: string[] = [];
	const denied: string[] = [];

	// Revalidate every record this client currently holds, not just the ones
	// named in this request: permissions can change between calls (e.g. a
	// token's document access is revoked mid-session), and a hold on a record
	// this request doesn't mention must not silently persist — and keep
	// having its TTL renewed forever — just because a later call happens to
	// be about unrelated records.
	const retained = existingHeldIds.filter((id) => permissionCheck(id));
	const anyRevoked = retained.length !== existingHeldIds.length;
	const alreadyOwn = new Set(existingHeldIds);
	const stillAuthorized = new Set(retained);

	for (const id of recordIds) {
		if (alreadyOwn.has(id)) {
			if (stillAuthorized.has(id)) {
				granted.push(id);
			} else {
				denied.push(id);
			}
		} else if (currentlyHeld.has(id)) {
			denied.push(id);
		} else if (!permissionCheck(id)) {
			denied.push(id);
		} else {
			granted.push(id);
		}
	}

	if (granted.length > 0 || anyRevoked) {
		const nextHeld = Array.from(new Set([...retained, ...granted]));
		if (nextHeld.length > 0) {
			writeRemoteState(awareness, clientId, { actor, heldRecordIds: nextHeld });
			scheduleTtl(awareness, clientId);
		} else {
			writeRemoteState(awareness, clientId, null);
			clearTtl(awareness, clientId);
		}
	}

	return { granted, denied };
}

/** Releases the given record IDs from a client's holds, or every held record when `recordIds` is omitted. */
export function releaseAgentHold(
	awareness: Awareness,
	clientId: number,
	recordIds?: string[]
): void {
	const existing = readHoldState(awareness, clientId);
	if (!existing) return;

	if (!recordIds) {
		writeRemoteState(awareness, clientId, null);
		clearTtl(awareness, clientId);
		return;
	}

	const nextHeld = existing.heldRecordIds.filter((id) => !recordIds.includes(id));
	if (nextHeld.length === 0) {
		writeRemoteState(awareness, clientId, null);
		clearTtl(awareness, clientId);
	} else {
		writeRemoteState(awareness, clientId, { ...existing, heldRecordIds: nextHeld });
		scheduleTtl(awareness, clientId);
	}
}

/** Whether the given client currently holds `recordId`. */
export function isHeldByClient(awareness: Awareness, clientId: number, recordId: string): boolean {
	return readHoldState(awareness, clientId)?.heldRecordIds.includes(recordId) ?? false;
}

function scheduleTtl(awareness: Awareness, clientId: number): void {
	clearTtl(awareness, clientId);
	const timer = setTimeout(() => {
		writeRemoteState(awareness, clientId, null);
		timersFor(awareness).delete(clientId);
		activeTestTimers.delete(timer);
	}, AGENT_HOLD_TTL_MS);
	timer.unref?.();
	timersFor(awareness).set(clientId, timer);
	activeTestTimers.add(timer);
}

function clearTtl(awareness: Awareness, clientId: number): void {
	const timers = agentTtlTimers.get(awareness);
	const timer = timers?.get(clientId);
	if (timer) {
		clearTimeout(timer);
		activeTestTimers.delete(timer);
	}
	timers?.delete(clientId);
}

/** Test-only: drop module-level state between test runs. */
export function resetHoldsForTests(): void {
	clearAllTestTimers();
	wiredAwareness = new WeakSet<Awareness>();
}
