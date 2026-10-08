<script lang="ts">
	import { resolve } from '$app/paths';
	import Icon from '$lib/components/Icon.svelte';

	let {
		spaceId,
		parentDocTitle = null,
		title,
		outlineOpen = $bindable(false)
	}: {
		spaceId: string;
		parentDocTitle?: string | null;
		title: string;
		outlineOpen?: boolean;
	} = $props();
</script>

<!-- Breadcrumb / Hierarchy nav -->
<nav class="mb-4 flex items-center gap-1.5 text-xs text-muted">
	<a
		href={resolve('/space/[spaceId]', { spaceId })}
		class="flex items-center gap-1 transition-colors hover:text-accent"
	>
		<span>Workspace</span>
	</a>
	{#if parentDocTitle}
		<span>/</span>
		<span class="truncate">{parentDocTitle}</span>
	{/if}
	<span>/</span>
	<span class="truncate font-medium text-fg">{title || 'Untitled'}</span>
	<button
		type="button"
		onclick={() => (outlineOpen = !outlineOpen)}
		class="ml-auto flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-1 text-muted transition-colors hover:bg-surface hover:text-fg"
		class:text-accent={outlineOpen}
		aria-pressed={outlineOpen}
		aria-label="{outlineOpen ? 'Close' : 'Open'} document List View"
		title="List View"
	>
		<Icon name="list-view" size={15} />
	</button>
</nav>
