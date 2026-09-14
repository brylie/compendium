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

// A failed lookup is retried after this cooldown rather than blocked
// forever — resolveRecordDoc's own shard-lookup cache already evicts a
// rejected attempt so a *later* call retries fresh (yjs-client.ts); a
// permanent per-target failure flag here would silently defeat that and
// leave a synced_block unresolved forever after one transient network/
// server blip, even though the underlying primitive was designed to
// recover.
const RETRY_COOLDOWN_MS = 5000;

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
	const holders = new SvelteMap<string, ActorId>();
	// Plain bookkeeping, never read reactively — SvelteSet/SvelteMap only so
	// the svelte/prefer-svelte-reactivity lint rule (blanket, not usage-aware)
	// doesn't flag a mutable built-in inside a `.svelte.ts` module.
	const pending = new SvelteSet<string>();
	const failedAt = new SvelteMap<string, number>();
	const unsubscribers = new SvelteMap<string, () => void>();
	// Set by destroy() — guards a resolveRecordDoc call that was already in
	// flight when the viewing Document changed (or this component unmounted)
	// from installing an Awareness subscription after destroy() ran, which
	// nothing would ever unsubscribe again (this resolver instance is
	// discarded, not reused, once destroyed — see +page.svelte).
	let destroyed = false;

	function ensure(targetId: string): void {
		if (resolved.has(targetId) || pending.has(targetId)) return;
		const lastFailure = failedAt.get(targetId);
		if (lastFailure !== undefined && Date.now() - lastFailure < RETRY_COOLDOWN_MS) return;
		pending.add(targetId);
		resolveRecordDoc(targetId)
			.then(({ doc, awareness }) => {
				pending.delete(targetId);
				if (destroyed) return;
				failedAt.delete(targetId);
				resolved.set(targetId, { doc, awareness });
				const unsubscribePresence = subscribeHeldByOthers(awareness, (held) => {
					const actor = held.get(targetId);
					if (actor) holders.set(targetId, actor);
					else holders.delete(targetId);
				});
				// getShardDoc's WebsocketProvider connects lazily — `doc` can
				// still be empty right here (or missing whatever the target
				// record's own edits change later), with its real content
				// arriving only once the WebSocket's initial sync (or a later
				// remote edit) lands. Re-setting the same {doc, awareness}
				// value on every records-map mutation is what makes the
				// template's own reactive read of `resolved.get(targetId)`
				// recompute then — without this, a caller reading `doc`
				// straight from the resolved value would never learn that
				// its content changed underneath it.
				const recordsMap = doc.getMap('records');
				const onRecordsChange = () => resolved.set(targetId, { doc, awareness });
				recordsMap.observeDeep(onRecordsChange);
				unsubscribers.set(targetId, () => {
					recordsMap.unobserveDeep(onRecordsChange);
					unsubscribePresence();
				});
			})
			.catch(() => {
				pending.delete(targetId);
				if (destroyed) return;
				failedAt.set(targetId, Date.now());
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
		destroyed = true;
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
 *
 * `ensure` is meant to be called reactively (+page.svelte calls it from an
 * effect that reruns on every blocks/ydoc change, not once synchronously
 * right after connecting) — a cold connection's `ydoc` is still empty at
 * that instant, so an id list computed only then would always be empty.
 * `started` latches once a *non-empty* candidate list actually fires a
 * request, so the reactive rerun that first sees real post-sync content is
 * the one that fires it — and only that one: later reruns (on every
 * subsequent edit) don't send another request once one has already gone
 * out, keeping this a one-shot batch per Document view as intended.
 */
export function createSyncGroupResolver() {
	const cache = new SvelteMap<string, SyncGroup>();
	let started = false;

	function ensure(recordIds: string[]): void {
		if (started || recordIds.length === 0) return;
		started = true;
		fetch('/api/sync-groups', {
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
				// correctly from the local, live index. `started` stays true:
				// this is a one-shot-per-Document-view batch, not a cache
				// entry to retry (unlike resolveRecordDoc's per-target shard
				// lookup, a failed *whole-Document* batch retrying itself
				// automatically on every subsequent edit would be far more
				// request traffic than this feature is worth).
			});
	}

	function get(recordId: string): SyncGroup | undefined {
		return cache.get(recordId);
	}

	return { ensure, get };
}

export type SyncGroupResolver = ReturnType<typeof createSyncGroupResolver>;
