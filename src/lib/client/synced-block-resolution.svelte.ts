import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { resolveRecordDoc } from './yjs-client';
import { subscribeHeldByOthers } from './presence';
import type { ActorId } from '$lib/data/types';
import type { Backlink } from '$lib/data/links';

// #242's client-side cross-shard resolution: a synced_block whose
// referencedRecordId doesn't resolve against the viewing Document's own
// ydoc (record-ops.ts's getRecordYText only ever sees the shard it's given)
// may still live in a different Document's shard. These two small resolvers
// give +page.svelte an async, cached path to that target's doc/Awareness
// (content + hold visibility) and to its cross-shard "used in N places"
// data, without threading the whole editing model through an async
// indirection for the common (same-shard) case that needs neither.

export interface ResolvedRecordTarget {
	doc: Y.Doc;
	awareness: Awareness;
}

/**
 * Resolves and caches `{doc, awareness}` for synced_block target ids that a
 * local `getRecordYText` lookup couldn't find — i.e. likely cross-shard.
 * Also subscribes to each resolved target's own Awareness so a hold placed on
 * it elsewhere still surfaces here (issue #242's sub-task 4), merged into
 * `holderFor` rather than the viewing Document's own `heldByOthers` map
 * (which only ever reflects its own shard's Awareness).
 */
export function createSyncedBlockResolver() {
	const resolved = new SvelteMap<string, ResolvedRecordTarget>();
	const failed = new SvelteSet<string>();
	const holders = new SvelteMap<string, ActorId>();
	// Plain bookkeeping, never read reactively — SvelteSet/SvelteMap only so
	// the svelte/prefer-svelte-reactivity lint rule (blanket, not usage-aware)
	// doesn't flag a mutable built-in inside a `.svelte.ts` module.
	const pending = new SvelteSet<string>();
	const unsubscribers = new SvelteMap<string, () => void>();

	function ensure(targetId: string): void {
		if (resolved.has(targetId) || failed.has(targetId) || pending.has(targetId)) return;
		pending.add(targetId);
		resolveRecordDoc(targetId)
			.then(({ doc, awareness }) => {
				pending.delete(targetId);
				resolved.set(targetId, { doc, awareness });
				const unsubscribe = subscribeHeldByOthers(awareness, (held) => {
					const actor = held.get(targetId);
					if (actor) holders.set(targetId, actor);
					else holders.delete(targetId);
				});
				unsubscribers.set(targetId, unsubscribe);
			})
			.catch(() => {
				pending.delete(targetId);
				failed.add(targetId);
			});
	}

	function get(targetId: string): ResolvedRecordTarget | undefined {
		return resolved.get(targetId);
	}

	function holderFor(targetId: string): ActorId | undefined {
		return holders.get(targetId);
	}

	/** Tears down every cross-shard Awareness subscription this resolver opened — call when the viewing Document changes or this component unmounts. */
	function destroy(): void {
		for (const unsubscribe of unsubscribers.values()) unsubscribe();
		unsubscribers.clear();
	}

	return { ensure, get, holderFor, destroy };
}

export type SyncedBlockResolver = ReturnType<typeof createSyncedBlockResolver>;

export interface SyncGroup {
	source?: Backlink;
	instances: Backlink[];
}

/**
 * Fetches and caches the server-resolved, workspace-wide sync group (source
 * location + every synced_block instance, any shard) for a batch of record
 * ids — one request per Document view (see +page.svelte), not one per block.
 * An id the server had nothing to report for is simply absent from the
 * cache; callers fall back to their own same-Document computation in that
 * case (src/lib/data/links.ts's listSyncedBlockInstances stays live for
 * exactly that same-shard subset via its own Yjs observers — this only adds
 * what that structurally can't see).
 */
export function createSyncGroupResolver() {
	const cache = new SvelteMap<string, SyncGroup>();
	let inFlight: Promise<void> | undefined;

	function ensure(recordIds: string[]): void {
		if (inFlight || recordIds.length === 0) return;
		inFlight = fetch('/api/sync-groups', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ recordIds })
		})
			.then((res) => {
				if (!res.ok) throw new Error(`Sync group lookup failed: ${res.status}`);
				return res.json();
			})
			.then((body: Record<string, SyncGroup>) => {
				for (const [id, group] of Object.entries(body)) cache.set(id, group);
			})
			.catch(() => {
				// A failed batch just means the cross-shard augmentation is
				// missing this load — same-Document sync groups still render
				// correctly from the local, live index.
			})
			.finally(() => {
				inFlight = undefined;
			});
	}

	function get(recordId: string): SyncGroup | undefined {
		return cache.get(recordId);
	}

	return { ensure, get };
}

export type SyncGroupResolver = ReturnType<typeof createSyncGroupResolver>;
