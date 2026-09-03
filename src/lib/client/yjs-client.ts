import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import type { Awareness } from 'y-protocols/awareness';
import { browser } from '$app/environment';

// Browser counterpart to src/lib/server/workspace-store.ts's resolved
// context. Both connect to the same shared workspace room over /ws, so the
// same src/lib/data/* record functions work unmodified against either doc —
// per docs/specifications/architecture.md §2, UI and MCP share one data-access layer.

let doc: Y.Doc | null = null;
let provider: WebsocketProvider | null = null;

// One Y.Doc + WebsocketProvider per Collection shard (#120), memoized for
// the tab's lifetime — distinct from the shared 'workspace' room above,
// which only ever holds Documents (unsharded). Keyed by the server-resolved
// shardId — never assumed equal to the collectionId, since a Collection
// created before the shard-assignment cutover still resolves to the
// default shard (see GET /api/collections/[id]/shard).
const shardDocs = new Map<string, { doc: Y.Doc; provider: WebsocketProvider }>();

function wsUrl(): string {
	const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
	return `${proto}://${window.location.host}/ws`;
}

/**
 * Returns the shared 'workspace' room's Y.Doc, connecting a WebsocketProvider
 * to it on first call and memoizing both for the tab's lifetime. This is the
 * client-side half of the same shared doc that MCP tool handlers read/write
 * server-side, so anything read off it here is live with agent writes.
 */
export function getClientDoc(): Y.Doc {
	if (!browser) throw new Error('getClientDoc() is browser-only');
	if (doc) return doc;
	doc = new Y.Doc();
	provider = new WebsocketProvider(wsUrl(), 'workspace', doc);
	return doc;
}

/** The WebsocketProvider backing the shared workspace doc, creating the connection via {@link getClientDoc} if it doesn't exist yet. */
export function getClientProvider(): WebsocketProvider {
	getClientDoc();
	return provider!;
}

/** Awareness instance for the shared workspace connection — the source of truth for presence/holds on Documents. */
export function getClientAwareness(): Awareness {
	return getClientProvider().awareness;
}

/**
 * Returns the Y.Doc for a given Collection shard, connecting a WebsocketProvider
 * to its own `shard-<shardId>` room on first call and memoizing per shardId for
 * the tab's lifetime. Distinct from {@link getClientDoc}'s single shared doc —
 * every Collection lives in its own shard (#120).
 */
export function getShardDoc(shardId: string): Y.Doc {
	if (!browser) throw new Error('getShardDoc() is browser-only');
	const existing = shardDocs.get(shardId);
	if (existing) return existing.doc;
	const shardDoc = new Y.Doc();
	const shardProvider = new WebsocketProvider(wsUrl(), `shard-${shardId}`, shardDoc);
	shardDocs.set(shardId, { doc: shardDoc, provider: shardProvider });
	return shardDoc;
}

/** Awareness instance for the given shard's connection, creating it via {@link getShardDoc} if it doesn't exist yet. */
export function getShardAwareness(shardId: string): Awareness {
	getShardDoc(shardId);
	return shardDocs.get(shardId)!.provider.awareness;
}

// Memoizes each Collection's shard lookup for the tab's lifetime — a relation
// property's target Collection is very often *not* the one already being
// viewed, so resolving and connecting to it is a fresh cross-Collection
// lookup rather than something already in scope the way a view's own
// collectionId/shardId props are.
const collectionShardIds = new Map<string, Promise<string>>();

/**
 * Resolves an arbitrary Collection's shard and connects to it (memoized per
 * collectionId), for UI that needs to read a *different* Collection than the
 * one it's currently viewing — e.g. resolving a relation property's target
 * records for display or picking (issue #15). Same GET /api/collections/[id]/shard
 * + {@link getShardDoc} pairing every other Collection-content view already
 * does before connecting; this just gives that pairing one shared name
 * instead of every relation-consuming component re-deriving it.
 */
export async function resolveCollectionDoc(collectionId: string): Promise<Y.Doc> {
	let shardIdPromise = collectionShardIds.get(collectionId);
	if (!shardIdPromise) {
		shardIdPromise = fetch(`/api/collections/${collectionId}/shard`)
			.then((res) => res.json())
			.then((body: { shardId: string }) => body.shardId)
			// A rejected lookup (network blip, endpoint briefly down) must not
			// stay cached — every later resolveCollectionDoc(collectionId) call
			// would otherwise keep reusing that same rejection until a full page
			// reload, even once the endpoint recovers. Evicting on failure lets
			// the next call retry fresh instead.
			.catch((err: unknown) => {
				collectionShardIds.delete(collectionId);
				throw err;
			});
		collectionShardIds.set(collectionId, shardIdPromise);
	}
	const shardId = await shardIdPromise;
	return getShardDoc(shardId);
}
