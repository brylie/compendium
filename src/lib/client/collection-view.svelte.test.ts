import { describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import * as Y from 'yjs';
import { createCollection, setPrimaryField } from '$lib/data/collection-ops';
import { createRecord } from '$lib/data/record-ops';
import type { ViewConfig } from '$lib/data/views';
import type { PropertyDefinition } from '$lib/data/types';
import {
	autoPickGroupBy,
	useCollectionView,
	type CollectionViewSnapshot
} from './collection-view.svelte';

const actor = { kind: 'human' as const, userId: 'local' };

function withRoot(fn: () => void): () => void {
	return $effect.root(() => {
		fn();
	});
}

describe('useCollectionView', () => {
	it('reads the initial schema/rows/primaryFieldKey/collection once a doc is available', () => {
		const ydoc = new Y.Doc();
		const collection = createCollection(ydoc, {
			title: 'T',
			schema: [{ key: 'a', label: 'Alpha', type: 'text' }]
		});
		createRecord(ydoc, { parentId: collection.id, properties: {} }, actor);

		let view!: CollectionViewSnapshot;
		const destroy = withRoot(() => {
			view = useCollectionView(
				() => ydoc,
				() => collection.id
			);
		});
		flushSync();

		expect(view.schema).toEqual([{ key: 'a', label: 'Alpha', type: 'text' }]);
		expect(view.rows).toHaveLength(1);
		expect(view.collection?.id).toBe(collection.id);

		destroy();
		ydoc.destroy();
	});

	it('re-reads on every subsequent Yjs mutation to records/collections', () => {
		const ydoc = new Y.Doc();
		const collection = createCollection(ydoc, { title: 'T', schema: [] });

		let view!: CollectionViewSnapshot;
		const destroy = withRoot(() => {
			view = useCollectionView(
				() => ydoc,
				() => collection.id
			);
		});
		flushSync();
		expect(view.rows).toHaveLength(0);

		createRecord(ydoc, { parentId: collection.id, properties: {} }, actor);
		flushSync();
		expect(view.rows).toHaveLength(1);

		setPrimaryField(ydoc, collection.id, null);
		flushSync();
		expect(view.primaryFieldKey).toBeUndefined();

		destroy();
		ydoc.destroy();
	});

	it('does nothing while getDoc() returns undefined, and leaves the last snapshot in place', () => {
		const ydoc = new Y.Doc();
		const collection = createCollection(ydoc, {
			title: 'T',
			schema: [{ key: 'a', label: 'Alpha', type: 'text' }]
		});

		let active = $state(false);
		let view!: CollectionViewSnapshot;
		const destroy = withRoot(() => {
			view = useCollectionView(
				() => (active ? ydoc : undefined),
				() => collection.id
			);
		});
		flushSync();
		expect(view.schema).toEqual([]);

		active = true;
		flushSync();
		expect(view.schema).toEqual([{ key: 'a', label: 'Alpha', type: 'text' }]);

		active = false;
		flushSync();
		// Tearing down the subscription doesn't reset already-read state.
		expect(view.schema).toEqual([{ key: 'a', label: 'Alpha', type: 'text' }]);

		createRecord(ydoc, { parentId: collection.id, properties: {} }, actor);
		flushSync();
		// No longer subscribed, so this later mutation isn't picked up.
		expect(view.rows).toHaveLength(0);

		destroy();
		ydoc.destroy();
	});

	it('re-subscribes when collectionId changes, switching to the new Collection', () => {
		const ydoc = new Y.Doc();
		const first = createCollection(ydoc, {
			title: 'First',
			schema: [{ key: 'a', label: 'Alpha', type: 'text' }]
		});
		const second = createCollection(ydoc, {
			title: 'Second',
			schema: [{ key: 'b', label: 'Beta', type: 'number' }]
		});

		let currentId = $state(first.id);
		let view!: CollectionViewSnapshot;
		const destroy = withRoot(() => {
			view = useCollectionView(
				() => ydoc,
				() => currentId
			);
		});
		flushSync();
		expect(view.collection?.title).toBe('First');

		currentId = second.id;
		flushSync();
		expect(view.collection?.title).toBe('Second');
		expect(view.schema).toEqual([{ key: 'b', label: 'Beta', type: 'number' }]);

		destroy();
		ydoc.destroy();
	});

	it('invokes onSnapshot synchronously after every internal read', () => {
		const ydoc = new Y.Doc();
		const collection = createCollection(ydoc, { title: 'T', schema: [] });
		const seenRowCounts: number[] = [];

		const destroy = withRoot(() => {
			useCollectionView(
				() => ydoc,
				() => collection.id,
				(snapshot) => seenRowCounts.push(snapshot.rows.length)
			);
		});
		flushSync();
		expect(seenRowCounts).toEqual([0]);

		createRecord(ydoc, { parentId: collection.id, properties: {} }, actor);
		flushSync();
		// createRecord touches both the records map (the new record) and the
		// collections map (its membership array), so both observeDeep
		// subscriptions fire — same double-refresh every pre-existing call site
		// already had, not something this hook introduces.
		expect(seenRowCounts).toEqual([0, 1, 1]);

		destroy();
		ydoc.destroy();
	});
});

describe('autoPickGroupBy', () => {
	const schema: PropertyDefinition[] = [
		{ key: 'a', label: 'Alpha', type: 'text' },
		{ key: 'b', label: 'Beta', type: 'select', options: [] },
		{ key: 'c', label: 'Gamma', type: 'select', options: [] }
	];

	it('picks the first field of the given type when groupBy is unset', () => {
		const config: ViewConfig = {};
		const onConfigChange = vi.fn();
		autoPickGroupBy(schema, 'select', config, onConfigChange);
		expect(onConfigChange).toHaveBeenCalledWith({ ...config, groupBy: 'b' });
	});

	it('leaves an already-valid groupBy untouched', () => {
		const config: ViewConfig = { groupBy: 'c' };
		const onConfigChange = vi.fn();
		autoPickGroupBy(schema, 'select', config, onConfigChange);
		expect(onConfigChange).not.toHaveBeenCalled();
	});

	it('replaces a groupBy pointing at a field of the wrong type', () => {
		const config: ViewConfig = { groupBy: 'a' };
		const onConfigChange = vi.fn();
		autoPickGroupBy(schema, 'select', config, onConfigChange);
		expect(onConfigChange).toHaveBeenCalledWith({ ...config, groupBy: 'b' });
	});

	it('resolves to undefined when no field of the given type exists', () => {
		const config: ViewConfig = { groupBy: 'a' };
		const onConfigChange = vi.fn();
		autoPickGroupBy(schema, 'date', config, onConfigChange);
		expect(onConfigChange).toHaveBeenCalledWith({ ...config, groupBy: undefined });
	});
});
