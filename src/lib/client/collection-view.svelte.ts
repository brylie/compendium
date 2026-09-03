import type * as Y from 'yjs';
import { getCollectionView } from '$lib/data/views';
import type { ViewConfig } from '$lib/data/views';
import type { CollectionMeta, PropertyDefinition, WorkspaceRecord } from '$lib/data/types';

export interface CollectionViewSnapshot {
	schema: PropertyDefinition[];
	rows: WorkspaceRecord[];
	primaryFieldKey: string | undefined;
	collection: CollectionMeta | undefined;
}

/**
 * Reactively mirrors a Collection's schema/rows/primaryFieldKey out of Yjs —
 * the getCollectionView-plus-observeDeep boilerplate TableCollectionView,
 * BoardCollectionView, CalendarCollectionView, FieldManagerDialog, and
 * /table/[id] each used to duplicate individually (issue #103).
 *
 * Re-subscribes whenever `getDoc()`/`getCollectionId()` change, and re-reads
 * on every subsequent `records`/`collections` mutation. `getDoc` returning
 * `undefined` (not yet connected, or deliberately inactive — see
 * FieldManagerDialog, which only wants this live while its dialog is open)
 * tears down any existing subscription and leaves the last-read snapshot in
 * place rather than resetting it to empty.
 *
 * `onSnapshot`, when given, runs synchronously right after every internal
 * read, for view-specific logic that needs the exact same read a component's
 * own refresh() used to trigger inline — e.g. Board/Calendar's "auto-pick a
 * default groupBy once per connect."
 */
export function useCollectionView(
	getDoc: () => Y.Doc | undefined,
	getCollectionId: () => string,
	onSnapshot?: (snapshot: CollectionViewSnapshot) => void
): CollectionViewSnapshot {
	let schema: PropertyDefinition[] = $state([]);
	let rows: WorkspaceRecord[] = $state([]);
	let primaryFieldKey: string | undefined = $state();
	let collection: CollectionMeta | undefined = $state();

	$effect(() => {
		const doc = getDoc();
		const collectionId = getCollectionId();
		if (!doc) return;

		function refresh(): void {
			// Builds the snapshot from `view`/local bindings rather than reading
			// back the $state fields this same function just assigned below —
			// reading a piece of state from inside the effect that also writes
			// it makes the effect depend on its own write, which re-triggers
			// itself every time and blows Svelte's effect_update_depth guard.
			const view = getCollectionView(doc!, collectionId);
			const snapshotSchema = view.collection?.schema ?? [];
			const snapshotPrimaryFieldKey = view.collection?.primaryFieldKey;
			schema = snapshotSchema;
			rows = view.records;
			primaryFieldKey = snapshotPrimaryFieldKey;
			collection = view.collection;
			onSnapshot?.({
				schema: snapshotSchema,
				rows: view.records,
				primaryFieldKey: snapshotPrimaryFieldKey,
				collection: view.collection
			});
		}

		const recordsMap = doc.getMap('records');
		const collectionsMap = doc.getMap('collections');
		recordsMap.observeDeep(refresh);
		collectionsMap.observeDeep(refresh);
		refresh();

		return () => {
			recordsMap.unobserveDeep(refresh);
			collectionsMap.unobserveDeep(refresh);
		};
	});

	return {
		get schema() {
			return schema;
		},
		get rows() {
			return rows;
		},
		get primaryFieldKey() {
			return primaryFieldKey;
		},
		get collection() {
			return collection;
		}
	};
}

/**
 * Resolves `config.groupBy` to a schema field of the given `type` — the
 * current value if it still names an eligible field, otherwise the first
 * eligible field in schema order — and persists the change via
 * `onConfigChange` when it differs. Board/Calendar both call this from their
 * own `useCollectionView` `onSnapshot` callback to auto-pick a default
 * grouping property (a `select` field for Board, a `date` field for
 * Calendar) the first time a Collection connects; each still guards the
 * "once per connect" attempt itself; this only does the resolve-and-write.
 */
export function autoPickGroupBy(
	schema: PropertyDefinition[],
	type: PropertyDefinition['type'],
	config: ViewConfig,
	onConfigChange: (config: ViewConfig) => void
): void {
	const resolvedKey =
		config.groupBy && schema.some((p) => p.key === config.groupBy && p.type === type)
			? config.groupBy
			: schema.find((p) => p.type === type)?.key;
	if (resolvedKey !== config.groupBy) {
		onConfigChange({ ...config, groupBy: resolvedKey });
	}
}
