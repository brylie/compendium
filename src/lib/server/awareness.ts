import { Awareness } from 'y-protocols/awareness';
import { getYDoc } from './ydoc.js';
import { initHoldEviction, resetHoldEvictionForTests } from './holds.js';

// Ephemeral, per-client state (cursor position, holds) that isn't part of
// document content — never persisted, never CRDT-merged, auto-clears on
// disconnect. See docs/technical-design.md §4.
//
// Stored on globalThis rather than a module-scoped variable — see ydoc.ts
// for why: this file can be loaded through more than one separate module
// graph in the same process, and each would otherwise get its own
// disconnected Awareness instance bound to a possibly-different Y.Doc.
declare global {
	var __awareness: Awareness | undefined;
}

export function getAwareness(): Awareness {
	if (globalThis.__awareness) return globalThis.__awareness;
	const awareness = new Awareness(getYDoc());
	initHoldEviction(awareness);
	globalThis.__awareness = awareness;
	return awareness;
}

/** Test-only: drop the singleton so a fresh instance is created next call. */
export function resetAwarenessForTests(): void {
	globalThis.__awareness?.destroy();
	globalThis.__awareness = undefined;
	resetHoldEvictionForTests();
}
