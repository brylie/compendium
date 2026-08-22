import * as Y from 'yjs';
import { getSnapshotStore } from './store.js';

// Phase 0 is single-tenant, single workspace — one Y.Doc for everything.
// Both the y-websocket endpoint and the MCP server's tool handlers mutate
// this same instance so writes from either side appear live to the other
// with no polling (see docs/technical-design.md §1).

let ydoc: Y.Doc | null = null;
let saveTimer: ReturnType<typeof setInterval> | null = null;
let dirty = false;

const SAVE_INTERVAL_MS = 30_000;

export function getYDoc(): Y.Doc {
	if (ydoc) return ydoc;

	ydoc = new Y.Doc();
	const store = getSnapshotStore();
	const snapshot = store.loadLatest();
	if (snapshot) {
		Y.applyUpdate(ydoc, snapshot);
	}

	ydoc.on('update', () => {
		dirty = true;
	});

	saveTimer = setInterval(() => {
		flush();
	}, SAVE_INTERVAL_MS);
	saveTimer.unref?.();

	const shutdown = () => {
		flush();
		process.exit(0);
	};
	process.once('SIGINT', shutdown);
	process.once('SIGTERM', shutdown);

	return ydoc;
}

export function flush(): void {
	if (!ydoc || !dirty) return;
	getSnapshotStore().save(Y.encodeStateAsUpdate(ydoc));
	dirty = false;
}

/** Test-only: drop the singleton so a fresh in-memory doc is created next call. */
export function resetYDocForTests(): void {
	if (saveTimer) clearInterval(saveTimer);
	saveTimer = null;
	ydoc = null;
	dirty = false;
}
