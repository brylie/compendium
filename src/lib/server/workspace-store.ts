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
import { initHoldEviction, resetHoldEvictionForTests } from './holds.js';
import { ensureCatalogBootstrapped } from './catalog.js';

// This is the one place a {workspaceId, shardId} selector resolves to a live
// Y.Doc/Awareness/persistence/connection bundle. Every boundary that used to
// reach a process-global getYDoc()/getAwareness() (the WebSocket handler, the
// service layer, SvelteKit route loads) now resolves a WorkspaceContext here
// instead — see docs/specifications/architecture.md §1 and issue #30.
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
//
// State lives on globalThis, not a module-scoped variable, for the same
// reason ydoc.ts/awareness.ts/db/index.ts historically did: this file can be
// loaded through more than one separate module-resolution graph in the same
// process (Vite's own config-loading context vs. the app's SSR module
// graph), and each graph would otherwise get its own disconnected registry.

export const DEFAULT_WORKSPACE_ID = 'default';
export const DEFAULT_SHARD_ID = 'default';

const SAVE_INTERVAL_MS = 30_000;

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

declare global {
	var __workspaceContexts: Map<string, InternalContext> | undefined;
	var __workspaceShutdownWired: boolean | undefined;
}

function registry(): Map<string, InternalContext> {
	if (!globalThis.__workspaceContexts) globalThis.__workspaceContexts = new Map();
	return globalThis.__workspaceContexts;
}

// JSON-encoded rather than a delimited template string: a plain `${a}::${b}`
// join lets a caller-chosen workspaceId/shardId pair collide with a
// different pair (e.g. workspaceId "space::main" + shardId "primary" would
// produce the same string as workspaceId "space" + shardId "main::primary"),
// silently handing one caller another's doc/awareness/connections.
function keyFor(workspaceId: string, shardId: string): string {
	return JSON.stringify([workspaceId, shardId]);
}

function createContext(workspaceId: string, shardId: string): InternalContext {
	const doc = new Y.Doc();
	const snapshotStore = getSnapshotStore(workspaceId, shardId);
	const snapshot = snapshotStore.loadLatest();
	if (snapshot) {
		Y.applyUpdate(doc, snapshot);
	}
	// Backfills/bootstraps the catalog from this doc's current content the
	// first time this {workspaceId, shardId} resolves — see catalog.ts. Runs
	// after the snapshot load (so it sees real content) and before the audit
	// observer attaches (so it never produces a spurious audit trail).
	const { defaultSpaceId } = ensureCatalogBootstrapped(workspaceId, shardId, doc);
	attachDocAuditObserver(doc);
	attachCatalogMirrorObserver(workspaceId, doc);

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

	context.saveTimer = setInterval(() => flushContext(context, snapshotStore), SAVE_INTERVAL_MS);
	context.saveTimer.unref?.();

	wireShutdownOnce();

	return context;
}

/**
 * Resolves the live context for a {workspaceId, shardId} selector, creating
 * and lazily loading it from its last snapshot on first access. Defaults
 * fill in the Phase 0 single-workspace key when a caller omits the selector
 * entirely (the common case at every current boundary).
 */
export function resolveWorkspaceContext(selector: WorkspaceSelector = {}): WorkspaceContext {
	const workspaceId = selector.workspaceId ?? DEFAULT_WORKSPACE_ID;
	const shardId = selector.shardId ?? DEFAULT_SHARD_ID;
	const key = keyFor(workspaceId, shardId);
	const existing = registry().get(key);
	if (existing) return existing;

	const context = createContext(workspaceId, shardId);
	registry().set(key, context);
	return context;
}

function flushContext(
	context: InternalContext,
	snapshotStore = getSnapshotStore(context.workspaceId, context.shardId)
): void {
	if (!context.dirty) return;
	snapshotStore.save(Y.encodeStateAsUpdate(context.doc));
	context.dirty = false;
}

/** Flushes every currently-resolved context's dirty state to its own snapshot key. */
export function flush(): void {
	for (const context of registry().values()) {
		flushContext(context);
	}
}

/**
 * Registers a live connection (a WebSocket, in practice) against the context
 * it belongs to, so disconnect cleanup and idle-shard bookkeeping can be
 * scoped per shard rather than process-global. Returns an unregister
 * function the caller invokes on disconnect.
 */
export function registerConnection(context: WorkspaceContext, connection: unknown): () => void {
	const internal = context as InternalContext;
	internal.connections.add(connection);
	return () => {
		internal.connections.delete(connection);
	};
}

/**
 * Flushes and drops a context from the registry if it currently has no live
 * connections. Not wired into automatic disconnect handling yet — Phase 0
 * keeps its one workspace resident for the life of the process, since MCP
 * calls have no "connection" to hold it open the way a WebSocket does and
 * unloading it on every browser tab close would just reload it on the very
 * next MCP call. This is the seam #13's real per-shard lifecycle policy
 * plugs into once idle-unload is actually needed.
 */
export function releaseContextIfIdle(workspaceId: string, shardId: string): boolean {
	const key = keyFor(workspaceId, shardId);
	const context = registry().get(key);
	if (!context || context.connections.size > 0) return false;

	flushContext(context);
	if (context.saveTimer) clearInterval(context.saveTimer);
	context.awareness.destroy();
	registry().delete(key);
	return true;
}

function wireShutdownOnce(): void {
	if (globalThis.__workspaceShutdownWired) return;
	globalThis.__workspaceShutdownWired = true;
	const shutdown = () => {
		flushPendingAuditEvents();
		flushPendingCatalogMirrorEvents();
		flush();
		process.exit(0);
	};
	process.once('SIGINT', shutdown);
	process.once('SIGTERM', shutdown);
}

/** Test-only: drop every resolved context so a fresh doc/awareness is created next call. */
export function resetWorkspaceStoreForTests(): void {
	for (const context of registry().values()) {
		if (context.saveTimer) clearInterval(context.saveTimer);
		context.awareness.destroy();
	}
	globalThis.__workspaceContexts = undefined;
	resetAuditObserverForTests();
	resetCatalogMirrorObserverForTests();
	resetHoldEvictionForTests();
}
