<!--
	Test-only fixture — see BoardCollectionViewHarness.svelte for rationale.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import TableCollectionView from './TableCollectionView.svelte';
	import type { ViewConfig } from '$lib/data/views';
	import type { CollectionMeta } from '$lib/data/types';

	let {
		collectionId,
		initialConfig = {},
		onConfigChange,
		collections = []
	}: {
		collectionId: string;
		initialConfig?: ViewConfig;
		onConfigChange?: (config: ViewConfig) => void;
		collections?: CollectionMeta[];
	} = $props();

	let config: ViewConfig = $state(untrack(() => initialConfig));

	$effect(() => {
		onConfigChange?.(config);
	});
</script>

<TableCollectionView
	{collectionId}
	{config}
	onConfigChange={(next) => (config = next)}
	{collections}
/>
