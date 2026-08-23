import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeProviderInstance {
	url: string;
	room: string;
	doc: unknown;
	awareness: { fake: true };
}

const providerInstances: FakeProviderInstance[] = [];

vi.mock('y-websocket', () => {
	class FakeWebsocketProvider implements FakeProviderInstance {
		url: string;
		room: string;
		doc: unknown;
		awareness = { fake: true as const };
		constructor(url: string, room: string, doc: unknown) {
			this.url = url;
			this.room = room;
			this.doc = doc;
			providerInstances.push(this);
		}
	}
	return { WebsocketProvider: FakeWebsocketProvider };
});

describe('yjs-client: browser', () => {
	beforeEach(async () => {
		vi.resetModules();
		providerInstances.length = 0;
		vi.doMock('$app/environment', () => ({ browser: true }));
	});

	afterEach(() => {
		vi.doUnmock('$app/environment');
	});

	it('lazily creates a single Y.Doc and WebsocketProvider, reused on subsequent calls', async () => {
		const mod = await import('./yjs-client');
		const doc1 = mod.getClientDoc();
		const doc2 = mod.getClientDoc();
		expect(doc1).toBe(doc2);
		expect(providerInstances).toHaveLength(1);
	});

	it('connects to the "workspace" room at /ws, matching the page protocol', async () => {
		const mod = await import('./yjs-client');
		mod.getClientDoc();
		expect(providerInstances[0].room).toBe('workspace');
		expect(providerInstances[0].url).toMatch(/^wss?:\/\/.*\/ws$/);
	});

	it('getClientProvider returns the same singleton provider', async () => {
		const mod = await import('./yjs-client');
		const p1 = mod.getClientProvider();
		const p2 = mod.getClientProvider();
		expect(p1).toBe(p2);
		expect(providerInstances).toHaveLength(1);
	});

	it('getClientAwareness exposes the provider awareness', async () => {
		const mod = await import('./yjs-client');
		expect(mod.getClientAwareness()).toEqual({ fake: true });
	});
});

describe('yjs-client: outside the browser', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.doMock('$app/environment', () => ({ browser: false }));
	});

	afterEach(() => {
		vi.doUnmock('$app/environment');
	});

	it('throws instead of connecting during SSR', async () => {
		const mod = await import('./yjs-client');
		expect(() => mod.getClientDoc()).toThrow('getClientDoc() is browser-only');
	});
});
