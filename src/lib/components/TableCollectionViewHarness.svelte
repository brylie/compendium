<!--
	Test-only fixture — see BoardCollectionViewHarness.svelte for rationale.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import TableCollectionView from './TableCollectionView.svelte';
	import type { ViewConfig } from '$lib/data/views';

	let {
		collectionId,
		initialConfig = {},
		onConfigChange
	}: {
		collectionId: string;
		initialConfig?: ViewConfig;
		onConfigChange?: (config: ViewConfig) => void;
	} = $props();

	let config: ViewConfig = $state(untrack(() => initialConfig));

	$effect(() => {
		onConfigChange?.(config);
	});
</script>

<TableCollectionView {collectionId} {config} onConfigChange={(next) => (config = next)} />
