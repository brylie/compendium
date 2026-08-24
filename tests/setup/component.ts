import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/svelte';

// jsdom doesn't implement HTMLElement.innerText (jsdom/jsdom#1245), which
// BlockEditor.svelte reads to sync a contenteditable's content into Y.Text.
// This isn't a layout-aware equivalent of the real browser property (it
// won't turn a <br> into "\n"), but every component test only exercises
// plain-text content, so textContent is an exact stand-in here.
if (!('innerText' in HTMLElement.prototype)) {
	Object.defineProperty(HTMLElement.prototype, 'innerText', {
		get(this: HTMLElement) {
			return this.textContent ?? '';
		},
		set(this: HTMLElement, value: string) {
			this.textContent = value;
		},
		configurable: true
	});
}

// jsdom has no layout engine and doesn't implement ResizeObserver at all, but
// Svelte's `bind:clientWidth` uses one internally to react to size changes.
// Every component test that mounts an element using `bind:clientWidth`
// (Toolbar.svelte's responsive insert-group overflow) would otherwise throw
// "ResizeObserver is not defined" before it ever gets to observe anything —
// a no-op stub is enough since these tests drive the bound value directly
// via props rather than relying on real layout.
if (typeof globalThis.ResizeObserver === 'undefined') {
	globalThis.ResizeObserver = class ResizeObserver {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	};
}

afterEach(() => {
	cleanup();
});
