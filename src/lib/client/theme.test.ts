import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTheme, isDark, toggleTheme } from './theme';

// Node's own built-in `localStorage` global can shadow/break jsdom's
// window.localStorage in this test runtime, so each test gets a deterministic
// in-memory fake stubbed onto the bare `localStorage` identifier theme.ts
// actually reads/writes, rather than relying on whichever implementation the
// ambient global happens to resolve to.
function fakeStorage(): Storage {
	const store = new Map<string, string>();
	return {
		getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
		setItem: (key: string, value: string) => {
			store.set(key, value);
		},
		removeItem: (key: string) => {
			store.delete(key);
		},
		clear: () => {
			store.clear();
		},
		key: (index: number) => Array.from(store.keys())[index] ?? null,
		get length() {
			return store.size;
		}
	} as Storage;
}

describe('theme: browser preference storage', () => {
	beforeEach(() => {
		vi.stubGlobal('localStorage', fakeStorage());
		document.documentElement.classList.remove('dark');
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('defaults to "system" when nothing is stored', () => {
		expect(getTheme()).toBe('system');
	});

	it('reads back a previously stored theme', () => {
		localStorage.setItem('theme', 'dark');
		expect(getTheme()).toBe('dark');
	});

	it('reports isDark() from the root element class', () => {
		expect(isDark()).toBe(false);
		document.documentElement.classList.add('dark');
		expect(isDark()).toBe(true);
	});

	it('toggles from light to dark and persists the choice', () => {
		expect(toggleTheme()).toBe(true);
		expect(document.documentElement.classList.contains('dark')).toBe(true);
		expect(localStorage.getItem('theme')).toBe('dark');
	});

	it('toggles from dark back to light and persists the choice', () => {
		document.documentElement.classList.add('dark');
		expect(toggleTheme()).toBe(false);
		expect(document.documentElement.classList.contains('dark')).toBe(false);
		expect(localStorage.getItem('theme')).toBe('light');
	});

	it('falls back to "system" server-side, with no window', () => {
		vi.stubGlobal('window', undefined);
		expect(getTheme()).toBe('system');
	});

	it('reports not dark server-side, with no window', () => {
		vi.stubGlobal('window', undefined);
		expect(isDark()).toBe(false);
	});

	it('no-ops toggling server-side, with no window', () => {
		vi.stubGlobal('window', undefined);
		expect(toggleTheme()).toBe(false);
	});
});
