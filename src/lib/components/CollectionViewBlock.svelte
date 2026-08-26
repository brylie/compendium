<script lang="ts">
	import { resolve } from '$app/paths';
	import { CURRENT_USER } from '$lib/client/actor';
	import {
		getCollection,
		listCollections,
		setRecordReferencedId,
		setRecordViewConfig
	} from '$lib/data/records';
	import type { EmbeddedViewConfig, ViewType, WorkspaceRecord } from '$lib/data/types';
	import type * as Y from 'yjs';
	import Icon from './Icon.svelte';
	import TableCollectionView from './TableCollectionView.svelte';
	import BoardCollectionView from './BoardCollectionView.svelte';
	import CalendarCollectionView from './CalendarCollectionView.svelte';

	let {
		block,
		ydoc
	}: {
		block: WorkspaceRecord;
		ydoc: Y.Doc;
	} = $props();

	const VIEW_TYPES: { value: ViewType; label: string; icon: 'table' | 'board' | 'calendar' }[] = [
		{ value: 'table', label: 'Table', icon: 'table' },
		{ value: 'board', label: 'Board', icon: 'board' },
		{ value: 'calendar', label: 'Calendar', icon: 'calendar' }
	];

	const collection = $derived(
		block.referencedRecordId ? getCollection(ydoc, block.referencedRecordId) : undefined
	);
	const isBroken = $derived(!!block.referencedRecordId && !collection);
	const isConfigured = $derived(!!collection && !!block.viewConfig?.viewType);

	let pickerCollectionId = $state('');
	let pickerViewType: ViewType = $state('table');
	let changing = $state(false);

	function insert(): void {
		if (!pickerCollectionId) return;
		setRecordReferencedId(ydoc, block.id, pickerCollectionId, CURRENT_USER);
		setRecordViewConfig(ydoc, block.id, { viewType: pickerViewType }, CURRENT_USER);
		changing = false;
	}

	function config(): EmbeddedViewConfig {
		return block.viewConfig ?? { viewType: pickerViewType };
	}

	function onConfigChange(next: import('$lib/data/views').ViewConfig): void {
		setRecordViewConfig(
			ydoc,
			block.id,
			{ ...next, viewType: block.viewConfig?.viewType ?? pickerViewType },
			CURRENT_USER
		);
	}

	function startChange(): void {
		pickerCollectionId = block.referencedRecordId ?? '';
		pickerViewType = block.viewConfig?.viewType ?? 'table';
		changing = true;
	}
</script>

<div class="my-1 rounded-lg border border-border bg-surface/30 p-3">
	{#if isConfigured && !changing}
		<div class="mb-3 flex items-center justify-between">
			<div class="flex items-center gap-2 text-sm font-medium text-fg">
				<Icon name={block.viewConfig?.viewType ?? 'table'} size={16} class="text-accent" />
				<a href={resolve('/table/[id]', { id: collection!.id })} class="hover:underline">
					{collection!.title || 'Untitled Collection'}
				</a>
				<span class="text-xs text-muted">· {block.viewConfig?.viewType}</span>
			</div>
			<button
				type="button"
				onclick={startChange}
				class="rounded px-2 py-0.5 text-xs text-muted hover:text-accent"
			>
				Change
			</button>
		</div>

		{#if block.viewConfig?.viewType === 'table'}
			<TableCollectionView collectionId={collection!.id} config={config()} {onConfigChange} />
		{:else if block.viewConfig?.viewType === 'board'}
			<BoardCollectionView collectionId={collection!.id} config={config()} {onConfigChange} />
		{:else if block.viewConfig?.viewType === 'calendar'}
			<CalendarCollectionView collectionId={collection!.id} config={config()} {onConfigChange} />
		{/if}
	{:else if isBroken && !changing}
		<div class="flex items-center justify-between" role="alert">
			<span class="flex items-center gap-2 text-sm text-muted italic">
				<Icon name="table" size={16} class="flex-shrink-0 opacity-50" />
				Embedded collection was deleted
			</span>
			<button
				type="button"
				onclick={startChange}
				class="rounded px-2 py-0.5 text-xs text-muted hover:text-accent"
			>
				Change
			</button>
		</div>
	{:else}
		<div class="flex flex-wrap items-center gap-2 text-xs text-muted">
			<Icon name="table" size={15} class="flex-shrink-0 text-accent" />
			<span>Embed a collection view:</span>
			<select
				bind:value={pickerViewType}
				class="rounded border border-border bg-bg px-2 py-1 text-xs text-fg focus:border-accent"
			>
				{#each VIEW_TYPES as vt (vt.value)}
					<option value={vt.value}>{vt.label}</option>
				{/each}
			</select>
			<select
				bind:value={pickerCollectionId}
				class="rounded border border-border bg-bg px-2 py-1 text-xs text-fg focus:border-accent"
			>
				<option value="">Select collection…</option>
				{#each listCollections(ydoc) as c (c.id)}
					<option value={c.id}>{c.title || 'Untitled'}</option>
				{/each}
			</select>
			<button
				type="button"
				onclick={insert}
				disabled={!pickerCollectionId}
				class="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
			>
				Insert
			</button>
			{#if changing}
				<button
					type="button"
					onclick={() => (changing = false)}
					class="text-xs text-muted hover:text-fg"
				>
					Cancel
				</button>
			{/if}
		</div>
	{/if}
</div>
