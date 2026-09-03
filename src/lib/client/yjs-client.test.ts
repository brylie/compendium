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

	it('uses wss when the page itself is loaded over https', async () => {
		const originalLocation = window.location;
		Object.defineProperty(window, 'location', {
			// Plain-object mock of Location for yjs-client.ts's protocol/host
			// read — only data properties matter here, not Location's
			// prototype methods (assign/reload/etc.), which the code under
			// test never calls.
			// eslint-disable-next-line @typescript-eslint/no-misused-spread
			value: { ...originalLocation, protocol: 'https:', host: originalLocation.host },
			writable: true,
			configurable: true
		});
		try {
			const mod = await import('./yjs-client');
			mod.getClientDoc();
			expect(providerInstances[0].url).toMatch(/^wss:\/\//);
		} finally {
			Object.defineProperty(window, 'location', {
				value: originalLocation,
				writable: true,
				configurable: true
			});
		}
	});

	it('lazily creates a shard Y.Doc and WebsocketProvider per shardId, reusing it on subsequent calls', async () => {
		const mod = await import('./yjs-client');
		const docA1 = mod.getShardDoc('shard-a');
		const docA2 = mod.getShardDoc('shard-a');
		expect(docA1).toBe(docA2);
		expect(providerInstances).toHaveLength(1);
		expect(providerInstances[0].room).toBe('shard-shard-a');

		const docB = mod.getShardDoc('shard-b');
		expect(docB).not.toBe(docA1);
		expect(providerInstances).toHaveLength(2);
	});

	it('getShardAwareness exposes the matching shard provider awareness', async () => {
		const mod = await import('./yjs-client');
		mod.getShardDoc('shard-c');
		expect(mod.getShardAwareness('shard-c')).toEqual({ fake: true });
	});

	describe('resolveCollectionDoc (issue #15)', () => {
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it("fetches the Collection's shard and connects via getShardDoc", async () => {
			const fetchMock = vi.fn(async () => ({ json: async () => ({ shardId: 'shard-x' }) }));
			vi.stubGlobal('fetch', fetchMock);
			const mod = await import('./yjs-client');

			const doc = await mod.resolveCollectionDoc('col-1');

			expect(fetchMock).toHaveBeenCalledWith('/api/collections/col-1/shard');
			expect(doc).toBe(mod.getShardDoc('shard-x'));
			expect(providerInstances).toHaveLength(1);
		});

		it('memoizes the shard lookup per collectionId — one fetch no matter how many calls', async () => {
			const fetchMock = vi.fn(async () => ({ json: async () => ({ shardId: 'shard-x' }) }));
			vi.stubGlobal('fetch', fetchMock);
			const mod = await import('./yjs-client');

			await mod.resolveCollectionDoc('col-1');
			await mod.resolveCollectionDoc('col-1');
			await mod.resolveCollectionDoc('col-1');

			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it('resolves different Collections to their own shard independently', async () => {
			const fetchMock = vi.fn(async (url: string) => ({
				json: async () => ({ shardId: url.includes('col-a') ? 'shard-a' : 'shard-b' })
			}));
			vi.stubGlobal('fetch', fetchMock);
			const mod = await import('./yjs-client');

			const docA = await mod.resolveCollectionDoc('col-a');
			const docB = await mod.resolveCollectionDoc('col-b');

			expect(docA).not.toBe(docB);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it('evicts a failed lookup from the cache, so a later call retries instead of reusing the rejection', async () => {
			const fetchMock = vi
				.fn()
				.mockRejectedValueOnce(new Error('network error'))
				.mockImplementation(async () => ({ json: async () => ({ shardId: 'shard-x' }) }));
			vi.stubGlobal('fetch', fetchMock);
			const mod = await import('./yjs-client');

			await expect(mod.resolveCollectionDoc('col-1')).rejects.toThrow('network error');
			const doc = await mod.resolveCollectionDoc('col-1');

			expect(doc).toBe(mod.getShardDoc('shard-x'));
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});
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

	it('getShardDoc also throws instead of connecting during SSR', async () => {
		const mod = await import('./yjs-client');
		expect(() => mod.getShardDoc('shard-a')).toThrow('getShardDoc() is browser-only');
	});
});
