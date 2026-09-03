<script lang="ts">
	import { SvelteMap } from 'svelte/reactivity';
	import { nanoid } from 'nanoid';
	import type * as Y from 'yjs';
	import { getShardDoc } from '$lib/client/yjs-client';
	import { CURRENT_USER } from '$lib/client/actor';
	import {
		autoPickGroupBy,
		useCollectionView,
		type CollectionViewSnapshot
	} from '$lib/client/collection-view.svelte';
	import {
		createRecord,
		deleteRecord,
		resolvePrimaryField,
		updateCollectionSchema,
		updateRecordProperties
	} from '$lib/data/records';
	import {
		dateKeyForRecord,
		primaryFieldDisplayValue,
		projectRecords,
		visibleProperties
	} from '$lib/data/views';
	import type { ViewConfig } from '$lib/data/views';
	import type { PropertyDefinition, PropertyValue, WorkspaceRecord } from '$lib/data/types';
	import Icon from './Icon.svelte';
	import PropertyValueCell from './PropertyValueCell.svelte';
	import ViewToolbar from './ViewToolbar.svelte';
	import PromptDialog from './PromptDialog.svelte';

	let {
		collectionId,
		config,
		onConfigChange
	}: {
		collectionId: string;
		config: ViewConfig;
		onConfigChange: (config: ViewConfig) => void;
	} = $props();

	const today = new Date();

	let ydoc: Y.Doc | undefined = $state();
	let shardId: string | undefined = $state();
	// Set in lockstep with ydoc (never the raw collectionId prop) below — the
	// prop can change synchronously on retarget while ydoc only catches up
	// once the async shard fetch resolves, and useCollectionView must never
	// see a doc paired with a collectionId it doesn't belong to.
	let resolvedCollectionId: string | undefined = $state();
	let viewYear = $state(today.getFullYear());
	let viewMonth = $state(today.getMonth()); // 0-11
	let newDatePropertyLabel = $state('Date');
	let optionDialogPropertyKey: string | null = $state(null);

	// Auto-picking a default groupBy is attempted at most once per
	// collectionId, not on every refresh — the hook's snapshot callback fires
	// on every Yjs change (including the auto-pick's own write), so
	// re-attempting it each time would loop forever whenever config never
	// actually changes back (e.g. no date property exists yet, so
	// resolvedKey stays undefined).
	let autoGroupByAttempted = false;

	function handleSnapshot(snapshot: CollectionViewSnapshot): void {
		if (autoGroupByAttempted) return;
		autoGroupByAttempted = true;
		autoPickGroupBy(snapshot.schema, 'date', config, onConfigChange);
	}

	const view = useCollectionView(
		() => ydoc,
		() => resolvedCollectionId ?? collectionId,
		handleSnapshot
	);
	const schema = $derived(view.schema);
	const rows = $derived(view.rows);
	const primaryFieldKey = $derived(view.primaryFieldKey);

	// The date property driving placement is config.groupBy, persisted on
	// the embedding block — see EmbeddedViewConfig in $lib/data/types.
	const dateProperties = $derived(schema.filter((p) => p.type === 'date'));
	const dateProperty = $derived(schema.find((p) => p.key === config.groupBy));
	const titleProperty = $derived(resolvePrimaryField(schema, primaryFieldKey));
	const projected = $derived(projectRecords(rows, schema, config));
	const entryFields = $derived(
		visibleProperties(schema, config).filter(
			(p) => p.key !== config.groupBy && p.key !== titleProperty?.key
		)
	);

	const scheduled = $derived.by(() => {
		const buckets = new SvelteMap<string, WorkspaceRecord[]>();
		if (!dateProperty) return buckets;
		for (const record of projected) {
			const key = dateKeyForRecord(record, dateProperty);
			if (!key) continue;
			buckets.set(key, [...(buckets.get(key) ?? []), record]);
		}
		return buckets;
	});

	const unscheduled = $derived(
		dateProperty ? projected.filter((r) => !dateKeyForRecord(r, dateProperty)) : []
	);

	function pad(n: number): string {
		return String(n).padStart(2, '0');
	}

	function dateKey(year: number, month: number, day: number): string {
		return `${year}-${pad(month + 1)}-${pad(day)}`;
	}

	const monthLabel = $derived(
		new Date(viewYear, viewMonth, 1).toLocaleDateString(undefined, {
			month: 'long',
			year: 'numeric'
		})
	);

	// Weeks of day-cells for the current month, Sunday-first, padded with the
	// trailing days of the previous/next month so every week row has 7 cells.
	const weeks = $derived.by(() => {
		const firstOfMonth = new Date(viewYear, viewMonth, 1);
		const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
		const startWeekday = firstOfMonth.getDay();
		const cells: { year: number; month: number; day: number; inMonth: boolean }[] = [];

		const prevMonthDays = new Date(viewYear, viewMonth, 0).getDate();
		for (let i = startWeekday - 1; i >= 0; i--) {
			cells.push({
				year: viewMonth === 0 ? viewYear - 1 : viewYear,
				month: (viewMonth + 11) % 12,
				day: prevMonthDays - i,
				inMonth: false
			});
		}
		for (let day = 1; day <= daysInMonth; day++) {
			cells.push({ year: viewYear, month: viewMonth, day, inMonth: true });
		}
		while (cells.length % 7 !== 0 || cells.length < 42) {
			const last = cells[cells.length - 1];
			const next = new Date(last.year, last.month, last.day + 1);
			cells.push({
				year: next.getFullYear(),
				month: next.getMonth(),
				day: next.getDate(),
				inMonth: false
			});
			if (cells.length >= 42) break;
		}

		const result: (typeof cells)[] = [];
		for (let i = 0; i < cells.length; i += 7) result.push(cells.slice(i, i + 7));
		return result;
	});

	// Resolves this Collection's real shard (#120) and (re)connects whenever
	// collectionId changes — see TableCollectionView's identical pattern for
	// why this can't just be a one-time onMount now that Collections have
	// their own shards.
	$effect(() => {
		const id = collectionId;
		autoGroupByAttempted = false;
		let cancelled = false;

		(async () => {
			const res = await fetch(`/api/collections/${id}/shard`);
			const { shardId: resolvedShardId } = await res.json();
			if (cancelled) return;

			shardId = resolvedShardId;
			resolvedCollectionId = id;
			ydoc = getShardDoc(resolvedShardId);
			// A rejection here (network failure, bad response) previously
			// vanished as a silent unhandled rejection — this at least
			// surfaces it, without inventing a toast/error-UI system this
			// lint pass isn't scoped to add.
		})().catch((err: unknown) => {
			console.error(`Failed to resolve shard for collection ${id}:`, err);
		});

		return () => {
			cancelled = true;
		};
	});

	function addDateProperty(): void {
		if (!ydoc) return;
		const label = newDatePropertyLabel.trim();
		if (!label) return;
		const property: PropertyDefinition = { key: nanoid(8), label, type: 'date' };
		updateCollectionSchema(ydoc, collectionId, [...schema, property]);
		onConfigChange({ ...config, groupBy: property.key });
	}

	function goToMonth(delta: number): void {
		const next = new Date(viewYear, viewMonth + delta, 1);
		viewYear = next.getFullYear();
		viewMonth = next.getMonth();
	}

	function goToToday(): void {
		viewYear = today.getFullYear();
		viewMonth = today.getMonth();
	}

	function addEntry(year: number, month: number, day: number): void {
		if (!ydoc || !dateProperty) return;
		createRecord(
			ydoc,
			{
				parentId: collectionId,
				properties: { [dateProperty.key]: { type: 'date', value: dateKey(year, month, day) } }
			},
			CURRENT_USER
		);
	}

	function removeEntry(id: string): void {
		if (!ydoc) return;
		deleteRecord(ydoc, id);
	}

	function addSelectOption(propertyKey: string, rawLabel: string): void {
		if (!ydoc) return;
		const label = rawLabel.trim();
		if (!label) return;
		const nextSchema = schema.map((p) =>
			p.key === propertyKey
				? { ...p, options: [...(p.options ?? []), { id: nanoid(6), label }] }
				: p
		);
		updateCollectionSchema(ydoc, collectionId, nextSchema);
	}

	function openSelectOptionDialog(propertyKey: string): void {
		optionDialogPropertyKey = propertyKey;
	}

	function setCell(row: WorkspaceRecord, property: PropertyDefinition, value: PropertyValue): void {
		if (!ydoc) return;
		updateRecordProperties(ydoc, row.id, { [property.key]: value }, CURRENT_USER);
	}

	function entryTitle(row: WorkspaceRecord): string {
		const value = titleProperty ? row.properties?.[titleProperty.key] : undefined;
		return primaryFieldDisplayValue(value, titleProperty) || 'Untitled';
	}
</script>

{#if schema.length > 0}
	<ViewToolbar
		{collectionId}
		shardId={shardId!}
		{schema}
		bind:config={() => config, onConfigChange}
	/>
{/if}

{#if dateProperties.length === 0}
	<div class="rounded-lg border border-dashed border-border bg-surface/50 p-8 text-center">
		<p class="text-sm text-muted">
			Calendar view places records by a <strong>date</strong> property, and this collection doesn't have
			one yet.
		</p>
		<form
			class="mt-3 flex flex-wrap justify-center gap-2"
			onsubmit={(event) => {
				event.preventDefault();
				addDateProperty();
			}}
		>
			<label class="sr-only" for="calendar-new-date-property-{collectionId}"
				>Date property name</label
			>
			<input
				id="calendar-new-date-property-{collectionId}"
				type="text"
				bind:value={newDatePropertyLabel}
				class="min-w-40 rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg focus:border-accent focus:outline-none"
			/>
			<button
				type="submit"
				disabled={!newDatePropertyLabel.trim()}
				class="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
			>
				<Icon name="plus" size={14} />
				<span>Add a date property</span>
			</button>
		</form>
	</div>
{:else}
	<div class="mb-4 flex flex-wrap items-center gap-3">
		<label class="text-xs text-muted" for="calendar-date-property-{collectionId}">Dates from</label>
		<select
			id="calendar-date-property-{collectionId}"
			value={config.groupBy}
			onchange={(e) =>
				onConfigChange({ ...config, groupBy: (e.target as HTMLSelectElement).value })}
			class="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus:border-accent focus:outline-none"
		>
			{#each dateProperties as property (property.key)}
				<option value={property.key}>{property.label}</option>
			{/each}
		</select>

		<div class="ml-auto flex items-center gap-1">
			<button
				type="button"
				onclick={() => goToMonth(-1)}
				class="rounded p-1.5 text-muted hover:bg-surface hover:text-fg"
				aria-label="Previous month"
			>
				<Icon name="chevron-left" size={16} />
			</button>
			<button
				type="button"
				onclick={goToToday}
				class="rounded-md border border-border px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent"
			>
				Today
			</button>
			<span class="mx-2 min-w-32 text-center text-sm font-semibold text-fg">{monthLabel}</span>
			<button
				type="button"
				onclick={() => goToMonth(1)}
				class="rounded p-1.5 text-muted hover:bg-surface hover:text-fg"
				aria-label="Next month"
			>
				<Icon name="chevron-right" size={16} />
			</button>
		</div>
	</div>

	<div class="overflow-hidden rounded-lg border border-border">
		<div
			class="grid grid-cols-7 border-b border-border bg-surface text-center text-xs font-semibold text-muted"
		>
			{#each ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as day (day)}
				<div class="py-1.5">{day}</div>
			{/each}
		</div>
		{#each weeks as week, weekIndex (weekIndex)}
			<div class="grid grid-cols-7" class:border-b={weekIndex < weeks.length - 1}>
				{#each week as cell (cell.year + '-' + cell.month + '-' + cell.day)}
					{@const key = dateKey(cell.year, cell.month, cell.day)}
					{@const isToday =
						cell.year === today.getFullYear() &&
						cell.month === today.getMonth() &&
						cell.day === today.getDate()}
					<div
						class="group min-h-24 border-r border-border p-1.5 last:border-r-0"
						class:bg-surface-50={!cell.inMonth}
						class:opacity-50={!cell.inMonth}
					>
						<div class="mb-1 flex items-center justify-between">
							<span
								class="flex h-5 w-5 items-center justify-center rounded-full text-xs"
								class:bg-accent={isToday}
								class:text-accent-fg={isToday}
								class:text-muted={!isToday}
							>
								{cell.day}
							</span>
							<button
								type="button"
								onclick={() => addEntry(cell.year, cell.month, cell.day)}
								class="rounded p-0.5 text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-accent focus-visible:opacity-100"
								aria-label="Add entry on {key}"
							>
								<Icon name="plus" size={11} />
							</button>
						</div>
						<div class="space-y-1">
							{#each scheduled.get(key) ?? [] as row (row.id)}
								<div class="rounded border border-border bg-bg px-1.5 py-1 text-xs">
									<div class="flex items-center justify-between gap-1">
										<span class="truncate font-medium text-fg">{entryTitle(row)}</span>
										<button
											type="button"
											onclick={() => removeEntry(row.id)}
											class="p-0.5 text-muted hover:text-red-500"
											aria-label="Delete entry"
										>
											<Icon name="trash" size={10} />
										</button>
									</div>
									{#if dateProperty}
										<PropertyValueCell
											property={dateProperty}
											value={row.properties?.[dateProperty.key]}
											oninput={(value) => setCell(row, dateProperty, value)}
											compact
										/>
									{/if}
									{#each entryFields as property (property.key)}
										<PropertyValueCell
											{property}
											value={row.properties?.[property.key]}
											oninput={(value) => setCell(row, property, value)}
											onAddOption={() => openSelectOptionDialog(property.key)}
											compact
										/>
									{/each}
								</div>
							{/each}
						</div>
					</div>
				{/each}
			</div>
		{/each}
	</div>

	{#if unscheduled.length > 0}
		<section class="mt-6">
			<h2 class="mb-2 text-xs font-semibold tracking-wider text-muted uppercase">Unscheduled</h2>
			<div class="space-y-1.5">
				{#each unscheduled as row (row.id)}
					<div
						class="flex items-center gap-2 rounded-md border border-border bg-bg px-2.5 py-1.5 text-sm"
					>
						<span class="flex-1 truncate text-fg">{entryTitle(row)}</span>
						{#if dateProperty}
							<div class="w-36">
								<PropertyValueCell
									property={dateProperty}
									value={row.properties?.[dateProperty.key]}
									oninput={(value) => setCell(row, dateProperty, value)}
									compact
								/>
							</div>
						{/if}

						<button
							type="button"
							onclick={() => removeEntry(row.id)}
							class="p-0.5 text-muted hover:text-red-500"
							aria-label="Delete entry"
						>
							<Icon name="trash" size={12} />
						</button>
					</div>
				{/each}
			</div>
		</section>
	{/if}
{/if}

<PromptDialog
	open={optionDialogPropertyKey !== null}
	title="New option"
	label="Option name"
	placeholder="Option name"
	submitLabel="Add option"
	onSubmit={(value) => {
		if (optionDialogPropertyKey) addSelectOption(optionDialogPropertyKey, value);
		optionDialogPropertyKey = null;
	}}
	onCancel={() => (optionDialogPropertyKey = null)}
/>
