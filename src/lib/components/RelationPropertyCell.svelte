<script lang="ts">
	import { tick } from 'svelte';
	import type * as Y from 'yjs';
	import { resolveCollectionDoc } from '$lib/client/yjs-client';
	import { useCollectionView } from '$lib/client/collection-view.svelte';
	import { resolvePrimaryField } from '$lib/data/records';
	import { primaryFieldDisplayValue } from '$lib/data/views';
	import type { PropertyDefinition, PropertyValue } from '$lib/data/types';
	import Icon from './Icon.svelte';

	let {
		property,
		value,
		oninput,
		compact = false
	}: {
		property: PropertyDefinition;
		value: PropertyValue | undefined;
		oninput: (value: PropertyValue) => void;
		compact?: boolean;
	} = $props();

	// Resolves and connects to the relation's *target* Collection — almost
	// always a different Collection (and Yjs shard) than whichever one owns
	// this field, unlike every other property type here, which only ever
	// reads the row's own Collection. `resolvedFor` gates useCollectionView's
	// getDoc below so a stale doc from a previous targetCollectionId is never
	// read against the new one while the fetch for it is still in flight —
	// same "doc in lockstep with the id it belongs to" guard
	// Table/Board/CalendarCollectionView each already use for their own
	// collectionId/shardId pair.
	let targetDoc: Y.Doc | undefined = $state();
	let resolvedFor: string | undefined = $state();

	$effect(() => {
		const targetCollectionId = property.targetCollectionId;
		if (!targetCollectionId) {
			targetDoc = undefined;
			resolvedFor = undefined;
			return;
		}
		let cancelled = false;
		void resolveCollectionDoc(targetCollectionId).then((doc) => {
			if (cancelled) return;
			targetDoc = doc;
			resolvedFor = targetCollectionId;
		});
		return () => {
			cancelled = true;
		};
	});

	const view = useCollectionView(
		() => (resolvedFor === property.targetCollectionId ? targetDoc : undefined),
		() => property.targetCollectionId ?? ''
	);

	const titleProperty = $derived(resolvePrimaryField(view.schema, view.primaryFieldKey));
	const selectedIds = $derived((value as { value?: string[] } | undefined)?.value ?? []);

	function displayTitle(row: (typeof view.rows)[number]): string {
		return (
			primaryFieldDisplayValue(
				titleProperty ? row.properties?.[titleProperty.key] : undefined,
				titleProperty
			) || 'Untitled'
		);
	}

	interface Chip {
		id: string;
		title: string;
		// A deleted target record: the id is preserved (never silently
		// dropped) and rendered as a distinct, visually broken state, rather
		// than resolving to a blank/misleading title — same precedent
		// internal-links.md establishes for a page_link pointing at a deleted
		// Document (issue #15).
		broken: boolean;
	}

	const chips: Chip[] = $derived(
		selectedIds.map((id) => {
			const row = view.rows.find((r) => r.id === id);
			return row
				? { id, title: displayTitle(row), broken: false }
				: { id, title: id, broken: true };
		})
	);

	let query = $state('');
	let pickerOpen = $state(false);
	let searchInput: HTMLInputElement | undefined = $state();

	const candidates = $derived(
		view.rows
			.filter((r) => !selectedIds.includes(r.id))
			.filter(
				(r) => !query.trim() || displayTitle(r).toLowerCase().includes(query.trim().toLowerCase())
			)
			.slice(0, 20)
	);

	function addId(id: string): void {
		oninput({ type: 'relation', value: [...selectedIds, id] });
		query = '';
	}

	function removeId(id: string): void {
		oninput({ type: 'relation', value: selectedIds.filter((existing) => existing !== id) });
	}

	function openPicker(): void {
		pickerOpen = true;
		void tick().then(() => searchInput?.focus());
	}

	function closePicker(): void {
		pickerOpen = false;
		query = '';
	}
</script>

<div class="flex flex-wrap items-center gap-1 {compact ? 'py-0.5' : 'py-1'}">
	{#each chips as chip (chip.id)}
		<span
			class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs {chip.broken
				? 'border border-dashed border-red-400/60 text-red-500'
				: 'bg-surface text-fg'}"
			title={chip.broken ? 'Linked record was deleted' : chip.title}
		>
			{#if chip.broken}
				<Icon name="callout" size={11} />
			{/if}
			<span class="max-w-32 truncate">{chip.title}</span>
			<button
				type="button"
				onclick={() => removeId(chip.id)}
				class="text-muted hover:text-fg"
				aria-label="Remove {chip.title}"
			>
				<Icon name="close" size={10} />
			</button>
		</span>
	{/each}

	{#if !property.targetCollectionId}
		<span class="text-xs text-muted italic">No target collection set</span>
	{:else if resolvedFor === property.targetCollectionId && !view.collection}
		<span class="text-xs text-muted italic">Target collection not found</span>
	{:else}
		<div class="relative">
			{#if pickerOpen}
				<input
					type="text"
					bind:this={searchInput}
					bind:value={query}
					onkeydown={(e) => {
						if (e.key === 'Escape') closePicker();
					}}
					onblur={closePicker}
					placeholder="Search {view.collection?.title ?? 'records'}…"
					class="w-32 rounded border border-border bg-bg px-1.5 py-0.5 text-xs text-fg outline-none focus:border-accent"
				/>
				<div
					class="absolute top-full left-0 z-10 mt-1 max-h-40 w-48 overflow-y-auto rounded border border-border bg-bg py-1 shadow-md"
				>
					{#each candidates as row (row.id)}
						<button
							type="button"
							onmousedown={(e) => {
								e.preventDefault();
								addId(row.id);
							}}
							class="block w-full truncate px-2 py-1 text-left text-xs text-fg hover:bg-surface"
						>
							{displayTitle(row)}
						</button>
					{:else}
						<p class="px-2 py-1 text-xs text-muted italic">No matching records</p>
					{/each}
				</div>
			{:else}
				<button
					type="button"
					onclick={openPicker}
					class="rounded p-0.5 text-muted hover:text-accent"
					aria-label="Add {property.label}"
					title="Add"
				>
					<Icon name="plus" size={12} />
				</button>
			{/if}
		</div>
	{/if}
</div>
