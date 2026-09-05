<script lang="ts">
	import { untrack } from 'svelte';
	import type * as Y from 'yjs';
	import { resolve } from '$app/paths';
	import { updateCollectionTitle } from '$lib/data/collection-ops';
	import type { ViewConfig } from '$lib/data/views';
	import TableCollectionView from '$lib/components/TableCollectionView.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let ydoc: Y.Doc | undefined = $state();
	// Initial-render-only snapshot of the SSR-loaded title, shown before ydoc
	// mounts; TableCollectionView's onSnapshot callback below keeps it in
	// sync with the Y.Doc afterwards — untrack() here just tells Svelte
	// that's deliberate. Kept as its own $state (not a $derived off the
	// hook) because handleTitleInput below needs to assign it directly for
	// responsive typing, ahead of the Yjs write's own observer round-trip.
	let title: string = $state(untrack(() => data.title));
	// This route has no persisted ViewConfig of its own (unlike an embedded
	// collection_view block) — filters/sort/visible-fields chosen here are
	// session-local, resetting on reload.
	let config: ViewConfig = $state({});

	function handleTitleInput(event: Event): void {
		if (!ydoc) return;
		title = (event.target as HTMLInputElement).value;
		updateCollectionTitle(ydoc, data.collectionId, title);
	}
</script>

<svelte:head>
	<title>{title || 'Untitled'} · Compendium</title>
</svelte:head>

<div class="mx-auto max-w-5xl px-6 py-10">
	<nav class="mb-4 flex items-center gap-1.5 text-xs text-muted">
		<a href={resolve('/')} class="flex items-center gap-1 transition-colors hover:text-accent">
			<span>Workspace</span>
		</a>
		<span>/</span>
		<span class="font-medium text-fg">{title || 'Untitled'}</span>
	</nav>

	<input
		class="mb-6 w-full border-none bg-transparent font-display text-3xl font-semibold tracking-tight text-fg outline-none placeholder:text-muted/50 focus:ring-0 md:text-4xl"
		value={title}
		oninput={handleTitleInput}
		placeholder="Untitled Collection"
	/>

	<TableCollectionView
		collectionId={data.collectionId}
		{config}
		onConfigChange={(next) => (config = next)}
		collections={data.collections}
		variant="full-page"
		onConnect={(connection) => (ydoc = connection.ydoc)}
		onSnapshot={(snapshot) => (title = snapshot.collection?.title ?? data.title)}
	/>
</div>
