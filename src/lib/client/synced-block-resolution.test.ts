import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActorId } from '$lib/data/types';

const resolveRecordDoc = vi.fn();
vi.mock('./yjs-client', () => ({
	resolveRecordDoc: (...args: unknown[]) => resolveRecordDoc(...args)
}));

type PresenceCallback = (held: Map<string, ActorId>) => void;
const presenceSubscriptions = new Map<
	unknown,
	{ callback: PresenceCallback; unsubscribe: () => void }
>();
const subscribeHeldByOthers = vi.fn((awareness: unknown, callback: PresenceCallback) => {
	const unsubscribe = vi.fn();
	presenceSubscriptions.set(awareness, { callback, unsubscribe });
	return unsubscribe;
});
vi.mock('./presence', () => ({
	subscribeHeldByOthers: (...args: [unknown, PresenceCallback]) => subscribeHeldByOthers(...args)
}));

/** Flushes every already-scheduled microtask (mock promise resolutions), without depending on real or fake timers. */
async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

function fakeDoc() {
	const observers: (() => void)[] = [];
	return {
		getMap: () => ({
			observeDeep: (fn: () => void) => observers.push(fn),
			unobserveDeep: (fn: () => void) => {
				const i = observers.indexOf(fn);
				if (i >= 0) observers.splice(i, 1);
			}
		}),
		fireRecordsChange: () => observers.slice().forEach((fn) => fn())
	};
}

describe('synced-block-resolution.svelte: createSyncedBlockResolver (#242)', () => {
	beforeEach(() => {
		resolveRecordDoc.mockReset();
		subscribeHeldByOthers.mockClear();
		presenceSubscriptions.clear();
	});

	it('resolves a target and exposes it via get()', async () => {
		const { createSyncedBlockResolver } = await import('./synced-block-resolution.svelte');
		const doc = fakeDoc();
		const awareness = {};
		resolveRecordDoc.mockResolvedValue({ doc, awareness });

		const resolver = createSyncedBlockResolver();
		resolver.ensure('rec-1');
		await flush();

		expect(resolver.get('rec-1')?.doc).toBe(doc);
		expect(resolveRecordDoc).toHaveBeenCalledTimes(1);
	});

	it('does not re-resolve a target that is already resolved or in flight', async () => {
		const { createSyncedBlockResolver } = await import('./synced-block-resolution.svelte');
		const doc = fakeDoc();
		resolveRecordDoc.mockResolvedValue({ doc, awareness: {} });

		const resolver = createSyncedBlockResolver();
		resolver.ensure('rec-1');
		resolver.ensure('rec-1'); // still pending — must not fire a second lookup
		await flush();
		resolver.ensure('rec-1'); // already resolved — must not re-fetch

		expect(resolveRecordDoc).toHaveBeenCalledTimes(1);
	});

	it('retries a failed lookup only after the cooldown elapses', async () => {
		const nowSpy = vi.spyOn(Date, 'now');
		try {
			const { createSyncedBlockResolver } = await import('./synced-block-resolution.svelte');
			resolveRecordDoc.mockRejectedValueOnce(new Error('network error'));
			const doc = fakeDoc();
			resolveRecordDoc.mockResolvedValue({ doc, awareness: {} });

			nowSpy.mockReturnValue(1_000_000);
			const resolver = createSyncedBlockResolver();
			resolver.ensure('rec-1');
			await flush();
			expect(resolveRecordDoc).toHaveBeenCalledTimes(1);

			nowSpy.mockReturnValue(1_000_000 + 1000); // still within the cooldown
			resolver.ensure('rec-1');
			expect(resolveRecordDoc).toHaveBeenCalledTimes(1);

			nowSpy.mockReturnValue(1_000_000 + 5001); // cooldown elapsed
			resolver.ensure('rec-1');
			await flush();
			expect(resolver.get('rec-1')).toBeDefined();
			expect(resolveRecordDoc).toHaveBeenCalledTimes(2);
		} finally {
			nowSpy.mockRestore();
		}
	});

	it('automatically retries a failed lookup after the cooldown, with no caller ever calling ensure() again', async () => {
		vi.useFakeTimers();
		try {
			const { createSyncedBlockResolver } = await import('./synced-block-resolution.svelte');
			resolveRecordDoc.mockRejectedValueOnce(new Error('network error'));
			const doc = fakeDoc();
			resolveRecordDoc.mockResolvedValue({ doc, awareness: {} });

			const resolver = createSyncedBlockResolver();
			resolver.ensure('rec-1');
			await vi.advanceTimersByTimeAsync(0); // let the rejection settle
			expect(resolveRecordDoc).toHaveBeenCalledTimes(1);
			expect(resolver.get('rec-1')).toBeUndefined();

			// Nothing calls ensure() again — only the cooldown elapsing.
			await vi.advanceTimersByTimeAsync(5000);
			expect(resolveRecordDoc).toHaveBeenCalledTimes(2);
			expect(resolver.get('rec-1')).toBeDefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('destroy() cancels a scheduled retry so it never fires after teardown', async () => {
		vi.useFakeTimers();
		try {
			const { createSyncedBlockResolver } = await import('./synced-block-resolution.svelte');
			resolveRecordDoc.mockRejectedValue(new Error('network error'));

			const resolver = createSyncedBlockResolver();
			resolver.ensure('rec-1');
			await vi.advanceTimersByTimeAsync(0);
			expect(resolveRecordDoc).toHaveBeenCalledTimes(1);

			resolver.destroy();
			await vi.advanceTimersByTimeAsync(10_000);
			expect(resolveRecordDoc).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('merges a held-by-others actor from the resolved target’s own Awareness into holderFor', async () => {
		const { createSyncedBlockResolver } = await import('./synced-block-resolution.svelte');
		const doc = fakeDoc();
		const awareness = {};
		resolveRecordDoc.mockResolvedValue({ doc, awareness });

		const resolver = createSyncedBlockResolver();
		resolver.ensure('rec-1');
		await flush();

		const actor: ActorId = { kind: 'human', userId: 'other' };
		presenceSubscriptions.get(awareness)?.callback(new Map([['rec-1', actor]]));
		expect(resolver.holderFor('rec-1')).toEqual(actor);

		presenceSubscriptions.get(awareness)?.callback(new Map());
		expect(resolver.holderFor('rec-1')).toBeUndefined();
	});

	it('re-exposes the same target once its records map changes, so a caller reading get() again sees content that arrived after the initial (possibly still-empty) resolve', async () => {
		const { createSyncedBlockResolver } = await import('./synced-block-resolution.svelte');
		const doc = fakeDoc();
		resolveRecordDoc.mockResolvedValue({ doc, awareness: {} });

		const resolver = createSyncedBlockResolver();
		resolver.ensure('rec-1');
		await flush();

		const before = resolver.get('rec-1');
		doc.fireRecordsChange();
		const after = resolver.get('rec-1');
		expect(after?.doc).toBe(before?.doc);
	});

	it('destroy() unsubscribes presence and blocks an in-flight resolution from installing a listener after teardown', async () => {
		const { createSyncedBlockResolver } = await import('./synced-block-resolution.svelte');
		let resolveLookup!: (value: { doc: ReturnType<typeof fakeDoc>; awareness: object }) => void;
		resolveRecordDoc.mockReturnValue(
			new Promise((resolve) => {
				resolveLookup = resolve;
			})
		);

		const resolver = createSyncedBlockResolver();
		resolver.ensure('rec-1');
		resolver.destroy();

		const doc = fakeDoc();
		const awareness = {};
		resolveLookup({ doc, awareness });
		await flush();

		expect(resolver.get('rec-1')).toBeUndefined();
		expect(subscribeHeldByOthers).not.toHaveBeenCalled();
	});
});

describe('synced-block-resolution.svelte: createSyncGroupResolver (#242)', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('no-ops for an empty id list, without fetching', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: true, json: async () => ({}) }))
		);
		const { createSyncGroupResolver } = await import('./synced-block-resolution.svelte');
		const resolver = createSyncGroupResolver();
		resolver.ensure([]);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('fetches once for the first non-empty candidate list and never again, even after it resolves', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: true, json: async () => ({ 'rec-1': { instances: [] } }) }))
		);
		const { createSyncGroupResolver } = await import('./synced-block-resolution.svelte');
		const resolver = createSyncGroupResolver();
		resolver.ensure(['rec-1']);
		await flush();
		expect(resolver.get('rec-1')).toBeDefined();

		resolver.ensure(['rec-1', 'rec-2']); // later, larger candidate list — still one-shot
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('swallows a failed batch instead of throwing, leaving the cache empty', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: false, status: 500 }))
		);
		const { createSyncGroupResolver } = await import('./synced-block-resolution.svelte');
		const resolver = createSyncGroupResolver();
		expect(() => resolver.ensure(['rec-1'])).not.toThrow();
		await flush();
		expect(resolver.get('rec-1')).toBeUndefined();
	});
});
