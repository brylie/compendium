import { Awareness } from 'y-protocols/awareness';
import { getYDoc } from './ydoc.js';
import { initHoldEviction } from './holds.js';

// Ephemeral, per-client state (cursor position, holds) that isn't part of
// document content — never persisted, never CRDT-merged, auto-clears on
// disconnect. See docs/technical-design.md §4.
let awareness: Awareness | null = null;

export function getAwareness(): Awareness {
	if (awareness) return awareness;
	awareness = new Awareness(getYDoc());
	initHoldEviction(awareness);
	return awareness;
}

/** Test-only: drop the singleton so a fresh instance is created next call. */
export function resetAwarenessForTests(): void {
	awareness?.destroy();
	awareness = null;
}
