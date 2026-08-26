<script lang="ts">
	import { resolve } from '$app/paths';
	import Icon from './Icon.svelte';

	let {
		collectionId,
		active
	}: {
		collectionId: string;
		active: 'table' | 'board' | 'calendar';
	} = $props();

	const views = [
		{ id: 'table', label: 'Table', icon: 'table', path: '/table/[id]' },
		{ id: 'board', label: 'Board', icon: 'board', path: '/board/[id]' },
		{ id: 'calendar', label: 'Calendar', icon: 'calendar', path: '/calendar/[id]' }
	] as const;
</script>

<nav class="mb-4 flex items-center gap-1 border-b border-border" aria-label="Collection views">
	{#each views as view (view.id)}
		<a
			href={resolve(view.path, { id: collectionId })}
			class="flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors"
			class:border-accent={active === view.id}
			class:text-accent={active === view.id}
			class:border-transparent={active !== view.id}
			class:text-muted={active !== view.id}
			class:hover:text-fg={active !== view.id}
			aria-current={active === view.id ? 'page' : undefined}
		>
			<Icon name={view.icon} size={14} />
			<span>{view.label}</span>
		</a>
	{/each}
</nav>
