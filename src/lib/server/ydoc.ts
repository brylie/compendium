import * as Y from 'yjs';
import { getSnapshotStore } from './store.js';

// Phase 0 is single-tenant, single workspace — one Y.Doc for everything.
// Both the y-websocket endpoint and the MCP server's tool handlers mutate
// this same instance so writes from either side appear live to the other
// with no polling (see docs/technical-design.md §1).
//
// State lives on globalThis rather than a plain module-scoped variable:
// this file can end up loaded through more than one separate module graph
// in the same process (e.g. a bundler config's own import context vs. the
// app's normal SSR module graph, or a pre-built bundle vs. a test
// harness's live import of this same source file). Each such graph would
// otherwise get its own disconnected Y.Doc — and its own independent
// SAVE_INTERVAL_MS timer periodically clobbering the same sqlite file —
// despite each believing it holds "the" singleton. globalThis is the one
// thing every module graph in a process actually shares.

const SAVE_INTERVAL_MS = 30_000;

interface YDocState {
	doc: Y.Doc;
	saveTimer: ReturnType<typeof setInterval> | null;
	dirty: boolean;
}

declare global {
	var __agentSpaceYDocState: YDocState | undefined;
}

export function getYDoc(): Y.Doc {
	if (globalThis.__agentSpaceYDocState) return globalThis.__agentSpaceYDocState.doc;

	const doc = new Y.Doc();
	const store = getSnapshotStore();
	const snapshot = store.loadLatest();
	if (snapshot) {
		Y.applyUpdate(doc, snapshot);
	}

	const state: YDocState = { doc, saveTimer: null, dirty: false };
	globalThis.__agentSpaceYDocState = state;

	doc.on('update', () => {
		state.dirty = true;
	});

	state.saveTimer = setInterval(() => {
		flush();
	}, SAVE_INTERVAL_MS);
	state.saveTimer.unref?.();

	const shutdown = () => {
		flush();
		process.exit(0);
	};
	process.once('SIGINT', shutdown);
	process.once('SIGTERM', shutdown);

	return doc;
}

export function flush(): void {
	const state = globalThis.__agentSpaceYDocState;
	if (!state || !state.dirty) return;
	getSnapshotStore().save(Y.encodeStateAsUpdate(state.doc));
	state.dirty = false;
}

/** Test-only: drop the singleton so a fresh in-memory doc is created next call. */
export function resetYDocForTests(): void {
	if (globalThis.__agentSpaceYDocState?.saveTimer) {
		clearInterval(globalThis.__agentSpaceYDocState.saveTimer);
	}
	globalThis.__agentSpaceYDocState = undefined;
}
