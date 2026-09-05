<script lang="ts">
	import { tick } from 'svelte';
	import type * as Y from 'yjs';
	import { resolveCollectionDoc } from '$lib/client/yjs-client';
	import { useCollectionView } from '$lib/client/collection-view.svelte';
	import { resolvePrimaryField } from '$lib/data/collection-ops';
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
	let resolveFailed = $state(false);

	// Shared by the effect below and by retry() — a manual retry only ever
	// runs once the effect's own attempt has already settled (the Retry
	// button only renders after `resolveFailed`), so there's no real
	// concurrent-write race between them; the live `property.targetCollectionId`
	// comparison at commit time is what guards against a *stale* attempt
	// (this one, or the effect's) writing state after the field retargeted
	// to a different Collection while it was in flight.
	function beginResolve(targetCollectionId: string): void {
		resolveFailed = false;
		resolveCollectionDoc(targetCollectionId)
			.then((doc) => {
				if (property.targetCollectionId !== targetCollectionId) return;
				targetDoc = doc;
				resolvedFor = targetCollectionId;
			})
			.catch(() => {
				// A transient failure (network blip, shard endpoint briefly
				// down) shouldn't leave the picker looking merely empty with no
				// explanation, or leave an unhandled rejection behind —
				// resolveCollectionDoc itself evicts the failed lookup from its
				// cache, so a retry gets a fresh attempt, not the same cached
				// rejection.
				if (property.targetCollectionId !== targetCollectionId) return;
				resolveFailed = true;
			});
	}

	$effect(() => {
		const targetCollectionId = property.targetCollectionId;
		if (!targetCollectionId) {
			targetDoc = undefined;
			resolvedFor = undefined;
			resolveFailed = false;
			return;
		}
		beginResolve(targetCollectionId);
	});

	function retry(): void {
		if (property.targetCollectionId) beginResolve(property.targetCollectionId);
	}

	const view = useCollectionView(
		() => (resolvedFor === property.targetCollectionId ? targetDoc : undefined),
		() => property.targetCollectionId ?? ''
	);

	// Only once the target Collection is actually connected *and* confirmed
	// to exist do we have grounds to call a missing row "deleted" — before
	// that (still loading, unconfigured, resolution failed, or the target
	// Collection itself is gone) `view.rows` is simply empty, which must not
	// be mistaken for every selected id having been deleted.
	const targetReady = $derived(resolvedFor === property.targetCollectionId && !!view.collection);

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

	type ChipStyle = 'resolved' | 'broken' | 'pending';

	interface Chip {
		id: string;
		title: string;
		// 'broken': the target Collection is confirmed available but this id
		// no longer names a record in it — preserved and rendered as a
		// distinct, visually broken state rather than a blank/misleading
		// title, the same precedent internal-links.md establishes for a
		// page_link pointing at a deleted Document (issue #15). 'pending':
		// nothing confirmed yet either way (loading/unconfigured/errored/
		// target Collection missing) — shown as a plain, neutral id rather
		// than being misreported as deleted.
		style: ChipStyle;
	}

	const chips: Chip[] = $derived(
		selectedIds.map((id): Chip => {
			if (!targetReady) return { id, title: id, style: 'pending' };
			const row = view.rows.find((r) => r.id === id);
			return row
				? { id, title: displayTitle(row), style: 'resolved' }
				: { id, title: id, style: 'broken' };
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
			class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs {chip.style ===
			'broken'
				? 'border border-dashed border-red-400/60 text-red-500'
				: 'bg-surface text-fg'}"
			title={chip.style === 'broken' ? 'Linked record was deleted' : chip.title}
		>
			{#if chip.style === 'broken'}
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
	{:else if resolveFailed}
		<span class="text-xs text-red-500 italic">Couldn't load target collection</span>
		<button type="button" onclick={retry} class="text-xs text-muted hover:text-accent">
			Retry
		</button>
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
