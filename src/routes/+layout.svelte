<script lang="ts">
	import './layout.css';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
</script>

<div class="flex h-screen w-screen overflow-hidden bg-bg text-fg">
	<Sidebar
		initialDocuments={data.documents}
		initialCollections={data.collections}
		spaces={data.spaces}
		activeSpaceId={data.activeSpaceId}
	/>
	<main class="min-w-0 flex-1 overflow-y-auto">
		{@render children()}
	</main>
</div>
