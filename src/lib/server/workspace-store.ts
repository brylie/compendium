import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { getSnapshotStore } from './store.js';
import {
	attachDocAuditObserver,
	flushPendingAuditEvents,
	resetAuditObserverForTests
} from './audit-observer.js';
import {
	attachCatalogMirrorObserver,
	flushPendingCatalogMirrorEvents,
	resetCatalogMirrorObserverForTests
} from './catalog-mirror-observer.js';
import {
	attachRecordIndexObserver,
	resetRecordIndexObserverForTests
} from './record-index-observer.js';
import { rebuildRecordIndexForShard } from './record-index.js';
import { attachRecordLocatorObserver } from './record-locator-observer.js';
import { aggregateHolds, initHoldEviction, resetHoldEvictionForTests } from './holds.js';
import {
	backfillRecordLocators,
	ensureCatalogBootstrapped,
	reconcileCatalogMetadata,
	resolveSpaceForShard
} from './catalog.js';
import { getInstanceWorkspaceId } from './instance.js';
import { REPLAY_ORIGIN } from '../mutation-origin.js';

// A {workspaceId, shardId} selector resolves to a live Y.Doc/Awareness/
// persistence/connection bundle through a `WorkspaceStore` instance — see
// docs/specifications/architecture.md §1 and issue #30/#306. Every boundary
// that used to reach a process-global getYDoc()/getAwareness() (the
// WebSocket handler, the service layer, SvelteKit route loads) resolves a
// WorkspaceContext from a store instead of an implicit singleton.
//
// Phase 0 has no auth and exactly one real workspace/shard, so
// resolveWorkspaceContext() always returns the same DEFAULT_WORKSPACE_ID /
// DEFAULT_SHARD_ID context regardless of what selector a caller passes in —
// a client-supplied selector (e.g. the WebSocket room path segment) is
// accepted for forward compatibility with #13's real routing, but is a
// *selector*, never authority, until #13 adds the auth layer that would let
// it name a workspace this connection is actually entitled to. The registry
// itself is genuinely multi-key already (see workspace-store.test.ts's
// cross-context isolation coverage) — only the boundary resolution is
// pinned to one key for now.

// The literal fallback value — kept exported since many call sites and
// tests already reference it directly. resolveWorkspaceContext() itself no
// longer defaults to this constant directly; it defaults to
// getInstanceWorkspaceId() (#111), which falls back to this same literal
// when no COMPENDIUM_INSTANCE_ID is configured — so every existing test that
// doesn't set that env var sees identical behavior.
export const DEFAULT_WORKSPACE_ID = 'default';
export const DEFAULT_SHARD_ID = 'default';

const SAVE_INTERVAL_MS = 30_000;
const IDLE_SWEEP_INTERVAL_MS = 60_000;

export interface WorkspaceSelector {
	workspaceId?: string;
	shardId?: string;
}

/** The public bundle a resolved boundary call site gets back. */
export interface WorkspaceContext {
	readonly workspaceId: string;
	readonly shardId: string;
	readonly doc: Y.Doc;
	readonly awareness: Awareness;
	/** Live WebSocket connections currently bound to this context — see registerConnection/unregisterConnection. */
	readonly connections: ReadonlySet<unknown>;
	/** The catalog Space this context's Documents/Collections are bootstrapped into — see ./catalog.ts. */
	readonly defaultSpaceId: string;
}

interface InternalContext extends WorkspaceContext {
	connections: Set<unknown>;
	saveTimer: ReturnType<typeof setInterval> | null;
	dirty: boolean;
}

// JSON-encoded rather than a delimited template string: a plain `${a}::${b}`
// join lets a caller-chosen workspaceId/shardId pair collide with a
// different pair (e.g. workspaceId "space::main" + shardId "primary" would
// produce the same string as workspaceId "space" + shardId "main::primary"),
// silently handing one caller another's doc/awareness/connections.
function keyFor(workspaceId: string, shardId: string): string {
	return JSON.stringify([workspaceId, shardId]);
}

// A single process-level shutdown coordinator shared by every `WorkspaceStore`
// instance constructed in this module graph, rather than each store wiring
// its own `SIGINT`/`SIGTERM` listener. A per-instance listener would let two
// independently-constructed stores with unflushed dirty contexts race: Node
// invokes listeners for the same signal in registration order, and the first
// one to call `process.exit()` (as a naive per-instance handler would, right
// after flushing only its own registry) prevents every later listener —
// including a second store's own flush — from ever running. One shared `Set`
// plus exactly one listener pair flushes every live store before exiting,
// regardless of how many were constructed.
const liveStoresForShutdown = new Set<WorkspaceStore>();
let processShutdownWired = false;

function registerStoreForShutdown(store: WorkspaceStore): void {
	liveStoresForShutdown.add(store);
	if (processShutdownWired) return;
	processShutdownWired = true;
	const shutdown = () => {
		flushPendingAuditEvents();
		flushPendingCatalogMirrorEvents();
		for (const liveStore of liveStoresForShutdown) liveStore.flush();
		process.exit(0);
	};
	process.once('SIGINT', shutdown);
	process.once('SIGTERM', shutdown);
}

/**
 * Owns one workspaceId/shardId → WorkspaceContext registry, plus the
 * shutdown/idle-sweep wiring for whatever it resolves — an explicit,
 * constructable unit rather than a bare module-global Map (#303/#306). A
 * test that wants a workspace context genuinely isolated from every other
 * concurrently-running test constructs its own `new WorkspaceStore()`
 * instead of relying on the ambient default (see
 * workspace-store.test.ts's `test.concurrent` coverage) — production code
 * threads the one process-wide instance from `getDefaultWorkspaceStore()`
 * (via `RequestContext.workspaceStore`) instead.
 */
export class WorkspaceStore {
	private readonly registry = new Map<string, InternalContext>();
	private idleSweepTimer: ReturnType<typeof setInterval> | null = null;

	private createContext(workspaceId: string, shardId: string): InternalContext {
		const doc = new Y.Doc();
		const snapshotStore = getSnapshotStore(workspaceId, shardId);
		const snapshot = snapshotStore.loadLatest();
		if (snapshot) {
			Y.applyUpdate(doc, snapshot, REPLAY_ORIGIN);
		}
		// Backfills/bootstraps the catalog from this doc's current content the
		// first time this {workspaceId, shardId} resolves — see catalog.ts. Runs
		// after the snapshot load (so it sees real content) and before the audit
		// observer attaches (so it never produces a spurious audit trail).
		const { defaultSpaceId } = ensureCatalogBootstrapped(workspaceId, shardId, doc);
		reconcileCatalogMetadata(workspaceId, doc);
		// Repairs any record created via direct UI mutation before this shard was
		// last resolved (the observer below only reacts to new transactions) —
		// see catalog.ts's backfillRecordLocators and issue #253. Resolved via
		// resolveSpaceForShard, not the bare defaultSpaceId: a shard with
		// existing records to backfill was necessarily already fully created
		// (including its own Document/Collection locator), so this always finds
		// the real owning Space rather than mis-tagging every backfilled record
		// with the workspace's first Space.
		const backfillSpaceId = resolveSpaceForShard(workspaceId, shardId, defaultSpaceId);
		backfillRecordLocators(workspaceId, backfillSpaceId, shardId, doc);
		attachDocAuditObserver(doc);
		attachCatalogMirrorObserver(workspaceId, doc);
		attachRecordLocatorObserver(workspaceId, defaultSpaceId, shardId, doc);
		// Rebuild before attaching the live observer, matching the catalog's own
		// bootstrap-then-mirror ordering above: this shard's record_index rows
		// always start correct for whatever the snapshot just loaded (or empty,
		// for a brand-new shard), so the projection is never stale for content
		// that existed before this process/context resolved it.
		rebuildRecordIndexForShard(workspaceId, shardId, doc);
		attachRecordIndexObserver(workspaceId, shardId, doc);

		const awareness = new Awareness(doc);
		initHoldEviction(awareness);

		const context: InternalContext = {
			workspaceId,
			shardId,
			doc,
			awareness,
			defaultSpaceId,
			connections: new Set(),
			saveTimer: null,
			dirty: false
		};

		doc.on('update', () => {
			context.dirty = true;
		});

		context.saveTimer = setInterval(() => {
			try {
				this.flushContext(context, snapshotStore);
			} catch (error) {
				// Keep dirty state intact: the next interval retries reconciliation
				// from the already-persisted authoritative Yjs snapshot.
				console.error('Failed to flush workspace context; will retry', error);
			}
		}, SAVE_INTERVAL_MS);
		context.saveTimer.unref?.();

		registerStoreForShutdown(this);
		this.wireIdleSweepOnce();

		return context;
	}

	/**
	 * Resolves the live context for a workspaceId/shardId selector, creating
	 * and lazily loading it from its last snapshot on first access. Defaults
	 * fill in the Phase 0 single-workspace key when a caller omits the selector
	 * entirely (the common case at every current boundary).
	 *
	 * Snapshot persistence (`getSnapshotStore`, `./store.ts`) is a single
	 * shared SQLite history keyed only by `(workspaceId, shardId)` — not by
	 * which `WorkspaceStore` instance resolved it. Two independently-constructed
	 * stores that both resolve the *same* selector each get their own
	 * in-memory `Y.Doc` (the isolation `workspace-store.test.ts`'s
	 * `test.concurrent` coverage proves), but if both are ever flushed, they
	 * write to the same snapshot row and whichever flushes last wins — this
	 * class doesn't coordinate concurrent writers of one persisted key across
	 * instances. A caller that wants two stores to persist independently must
	 * give them distinct `workspaceId`s, not just distinct instances.
	 */
	resolve(selector: WorkspaceSelector = {}): WorkspaceContext {
		const workspaceId = selector.workspaceId ?? getInstanceWorkspaceId();
		const shardId = selector.shardId ?? DEFAULT_SHARD_ID;
		const key = keyFor(workspaceId, shardId);
		const existing = this.registry.get(key);
		if (existing) return existing;

		const context = this.createContext(workspaceId, shardId);
		this.registry.set(key, context);
		return context;
	}

	private flushContext(
		context: InternalContext,
		snapshotStore = getSnapshotStore(context.workspaceId, context.shardId)
	): void {
		if (!context.dirty) return;
		snapshotStore.save(Y.encodeStateAsUpdate(context.doc));
		// A direct Yjs update can commit while SQLite is temporarily unavailable.
		// Keep this context dirty until reconciliation succeeds so the next flush
		// retries from the authoritative snapshot without duplicating catalog rows.
		reconcileCatalogMetadata(context.workspaceId, context.doc);
		context.dirty = false;
	}

	/** Flushes every currently-resolved context's dirty state to its own snapshot key. */
	flush(): void {
		for (const context of this.registry.values()) {
			this.flushContext(context);
		}
	}

	/**
	 * Flushes and drops a context from the registry if it's currently idle:
	 * no live connections, and no active hold — checked separately, since an
	 * MCP agent's hold is a synthetic Awareness client with no WebSocket
	 * connection at all (holds.ts's clientIdForToken; agents are stateless
	 * HTTP). Unloading on "zero connections" alone would destroy an
	 * in-progress agent hold's Awareness state out from under it. Called by
	 * sweepIdleContexts() on a timer (see wireIdleSweepOnce below) and
	 * directly by tests; not itself timer-driven.
	 */
	releaseContextIfIdle(workspaceId: string, shardId: string): boolean {
		const key = keyFor(workspaceId, shardId);
		const context = this.registry.get(key);
		if (!context) return false;
		if (context.connections.size > 0) return false;
		if (aggregateHolds(context.awareness).size > 0) return false;

		this.flushContext(context);
		if (context.saveTimer) clearInterval(context.saveTimer);
		context.awareness.destroy();
		this.registry.delete(key);
		return true;
	}

	/**
	 * Re-evaluates every currently-resolved context and releases whichever are
	 * idle. Exported directly (not just reachable via the timer below) so tests
	 * can call it deterministically instead of waiting on real time — the same
	 * testability shape flush() already has relative to the save timer. The
	 * default workspaceId: 'default', shardId: 'default' context is not
	 * special-cased: once truly idle it unloads and reloads like any other,
	 * lazily reloading its snapshot on next resolution (see createContext).
	 */
	sweepIdleContexts(): void {
		for (const context of this.registry.values()) {
			this.releaseContextIfIdle(context.workspaceId, context.shardId);
		}
	}

	private wireIdleSweepOnce(): void {
		if (this.idleSweepTimer) return;
		this.idleSweepTimer = setInterval(() => this.sweepIdleContexts(), IDLE_SWEEP_INTERVAL_MS);
		this.idleSweepTimer.unref?.();
	}

	/**
	 * Test-only: drop every resolved context so a fresh doc/awareness is created next call, and
	 * stop this store's own idle-sweep timer and shutdown participation — a short-lived,
	 * `resetForTests()`-torn-down store (the common case for a `new WorkspaceStore()` a test
	 * constructs and discards) must not keep sweeping or hold a place in the shared shutdown
	 * coordinator for the rest of the process's life.
	 */
	resetForTests(): void {
		for (const context of this.registry.values()) {
			if (context.saveTimer) clearInterval(context.saveTimer);
			context.awareness.destroy();
		}
		this.registry.clear();
		if (this.idleSweepTimer) {
			clearInterval(this.idleSweepTimer);
			this.idleSweepTimer = null;
		}
		liveStoresForShutdown.delete(this);
		resetAuditObserverForTests();
		resetCatalogMirrorObserverForTests();
		resetRecordIndexObserverForTests();
		resetHoldEvictionForTests();
	}
}

// Lives on globalThis, not a module-scoped variable, for the same reason
// ydoc.ts/awareness.ts/db/index.ts historically did: this file can be
// loaded through more than one separate module-resolution graph in the same
// process (Vite's own config-loading context vs. the app's SSR module
// graph), and each graph would otherwise get its own disconnected default
// store. This is the *only* globalThis anchor left in this module — the
// registry itself now lives on a `WorkspaceStore` instance, not directly on
// globalThis — and it exists purely to give every module graph the same
// single production instance, not to smuggle ambient state past callers:
// every actual resolution still goes through an explicit `WorkspaceStore`
// reference (`RequestContext.workspaceStore`, or this getter for the
// handful of boundaries — the WS upgrade handler, SvelteKit route loads not
// yet carrying a RequestContext — that aren't part of #306's service-layer
// signature rewrite).
declare global {
	var __defaultWorkspaceStore: WorkspaceStore | undefined;
}

/** The one process-wide `WorkspaceStore` production boundaries share — see the module comment above. */
export function getDefaultWorkspaceStore(): WorkspaceStore {
	globalThis.__defaultWorkspaceStore ??= new WorkspaceStore();
	return globalThis.__defaultWorkspaceStore;
}

/**
 * Thin wrapper over `getDefaultWorkspaceStore().resolve()` — kept for the
 * boundaries that don't (yet) thread an explicit `WorkspaceStore` reference
 * (the WebSocket upgrade handler, migration scripts, a few read-only route
 * loads). Every `src/lib/services/*.ts` function resolves through
 * `RequestContext.workspaceStore` instead (see request-context.ts and
 * issue #306) rather than calling this ambiently.
 */
export function resolveWorkspaceContext(selector: WorkspaceSelector = {}): WorkspaceContext {
	return getDefaultWorkspaceStore().resolve(selector);
}

/** See {@link WorkspaceStore.flush} — flushes the default store. */
export function flush(): void {
	getDefaultWorkspaceStore().flush();
}

/**
 * Registers a live connection (a WebSocket, in practice) against the context
 * it belongs to, so disconnect cleanup and idle-shard bookkeeping can be
 * scoped per shard rather than process-global. Returns an unregister
 * function the caller invokes on disconnect. Doesn't need a store reference
 * of its own — it only mutates the context object it's handed.
 */
export function registerConnection(context: WorkspaceContext, connection: unknown): () => void {
	const internal = context as InternalContext;
	internal.connections.add(connection);
	return () => {
		internal.connections.delete(connection);
	};
}

/** See {@link WorkspaceStore.releaseContextIfIdle} — operates on the default store. */
export function releaseContextIfIdle(workspaceId: string, shardId: string): boolean {
	return getDefaultWorkspaceStore().releaseContextIfIdle(workspaceId, shardId);
}

/** See {@link WorkspaceStore.sweepIdleContexts} — operates on the default store. */
export function sweepIdleContexts(): void {
	getDefaultWorkspaceStore().sweepIdleContexts();
}

/** Test-only: drop every resolved context on the default store so a fresh doc/awareness is created next call. */
export function resetWorkspaceStoreForTests(): void {
	getDefaultWorkspaceStore().resetForTests();
}
