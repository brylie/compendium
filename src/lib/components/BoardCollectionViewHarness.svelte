<!--
	Test-only fixture: owns real $state for `config` so BoardCollectionView's
	onConfigChange callback drives genuine reactivity (including the
	synchronous auto-groupBy call refresh() makes during the very first
	mount, before a test's own render() call has even returned) — a plain
	rerender()-after-the-fact approach can't observe that first call in time.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import BoardCollectionView from './BoardCollectionView.svelte';
	import type { ViewConfig } from '$lib/data/views';

	let {
		collectionId,
		initialConfig = { sort: { mode: 'manual' } },
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

<BoardCollectionView {collectionId} {config} onConfigChange={(next) => (config = next)} />
