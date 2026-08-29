<!--
	Test-only fixture: @testing-library/svelte's render() passes props through
	a shallow (non-deep-reactive) proxy, so a $bindable prop mutated via a
	nested-field write (config.filters = ...) — as ViewToolbar does — never
	re-renders when the component is mounted directly in a test. This host
	owns a real (deep) $state and binds properly, matching how Board/Calendar
	actually use ViewToolbar (`bind:config`) in the app.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import ViewToolbar from './ViewToolbar.svelte';
	import type { PropertyDefinition } from '$lib/data/types';
	import type { ViewConfig } from '$lib/data/views';

	let {
		collectionId = 'col-1',
		schema,
		initialConfig = {},
		onConfigChange
	}: {
		collectionId?: string;
		schema: PropertyDefinition[];
		initialConfig?: ViewConfig;
		onConfigChange?: (config: ViewConfig) => void;
	} = $props();

	let config: ViewConfig = $state(untrack(() => initialConfig));

	$effect(() => {
		onConfigChange?.(config);
	});
</script>

<ViewToolbar {collectionId} {schema} bind:config />
