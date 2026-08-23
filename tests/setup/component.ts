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

afterEach(() => {
	cleanup();
});
