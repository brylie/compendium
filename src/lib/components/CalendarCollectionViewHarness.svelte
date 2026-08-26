<!--
	Test-only fixture — see BoardCollectionViewHarness.svelte for why a plain
	rerender()-after-the-fact approach can't work here (the synchronous
	auto-groupBy call refresh() makes on first mount needs real reactivity).
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import CalendarCollectionView from './CalendarCollectionView.svelte';
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

<CalendarCollectionView {collectionId} {config} onConfigChange={(next) => (config = next)} />
