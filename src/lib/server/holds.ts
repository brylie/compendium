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

const agentClocks = new Map<number, number>();
const agentTtlTimers = new Map<number, ReturnType<typeof setTimeout>>();
let evictionWired = false;

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
	if (evictionWired) return;
	evictionWired = true;

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

export function resetHoldEvictionForTests(): void {
	evictionWired = false;
	agentClocks.clear();
	agentTtlTimers.forEach((timer) => clearTimeout(timer));
	agentTtlTimers.clear();
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

/** Directly injects/overwrites a (possibly synthetic) remote client's Awareness
 *  state — the same mechanism a real peer's update takes, just constructed
 *  server-side instead of decoded off the wire. */
function writeRemoteState(
	awareness: Awareness,
	clientId: number,
	state: HoldAwarenessState | null
): void {
	const clock = (agentClocks.get(clientId) ?? 0) + 1;
	agentClocks.set(clientId, clock);

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

export function requestAgentHold(
	awareness: Awareness,
	clientId: number,
	actor: ActorId,
	recordIds: string[],
	permissionCheck: (recordId: string) => boolean
): HoldRequestResult {
	const currentlyHeld = aggregateHolds(awareness);
	const existing = readHoldState(awareness, clientId);
	const alreadyOwn = new Set(existing?.heldRecordIds ?? []);
	const granted: string[] = [];
	const denied: string[] = [];
	const revoked: string[] = [];

	for (const id of recordIds) {
		if (alreadyOwn.has(id)) {
			// Re-checked on every request rather than trusted from the prior grant:
			// permissions can change between calls (e.g. a token's document access
			// is revoked mid-session), so a stale "already own it" must not bypass
			// the check the record would otherwise be subject to.
			if (permissionCheck(id)) {
				granted.push(id);
			} else {
				denied.push(id);
				revoked.push(id);
			}
		} else if (currentlyHeld.has(id)) {
			denied.push(id);
		} else if (!permissionCheck(id)) {
			denied.push(id);
		} else {
			granted.push(id);
		}
	}

	if (granted.length > 0 || revoked.length > 0) {
		const retained = (existing?.heldRecordIds ?? []).filter((id) => !revoked.includes(id));
		const nextHeld = Array.from(new Set([...retained, ...granted]));
		if (nextHeld.length > 0) {
			writeRemoteState(awareness, clientId, { actor, heldRecordIds: nextHeld });
			scheduleTtl(awareness, clientId);
		} else {
			writeRemoteState(awareness, clientId, null);
			clearTtl(clientId);
		}
	}

	return { granted, denied };
}

export function releaseAgentHold(
	awareness: Awareness,
	clientId: number,
	recordIds?: string[]
): void {
	const existing = readHoldState(awareness, clientId);
	if (!existing) return;

	if (!recordIds) {
		writeRemoteState(awareness, clientId, null);
		clearTtl(clientId);
		return;
	}

	const nextHeld = existing.heldRecordIds.filter((id) => !recordIds.includes(id));
	if (nextHeld.length === 0) {
		writeRemoteState(awareness, clientId, null);
		clearTtl(clientId);
	} else {
		writeRemoteState(awareness, clientId, { ...existing, heldRecordIds: nextHeld });
		scheduleTtl(awareness, clientId);
	}
}

export function isHeldByClient(awareness: Awareness, clientId: number, recordId: string): boolean {
	return readHoldState(awareness, clientId)?.heldRecordIds.includes(recordId) ?? false;
}

function scheduleTtl(awareness: Awareness, clientId: number): void {
	clearTtl(clientId);
	const timer = setTimeout(() => {
		writeRemoteState(awareness, clientId, null);
		agentTtlTimers.delete(clientId);
	}, AGENT_HOLD_TTL_MS);
	timer.unref?.();
	agentTtlTimers.set(clientId, timer);
}

function clearTtl(clientId: number): void {
	const timer = agentTtlTimers.get(clientId);
	if (timer) clearTimeout(timer);
	agentTtlTimers.delete(clientId);
}

/** Test-only: drop module-level state between test runs. */
export function resetHoldsForTests(): void {
	agentClocks.clear();
	for (const timer of agentTtlTimers.values()) clearTimeout(timer);
	agentTtlTimers.clear();
	evictionWired = false;
}
