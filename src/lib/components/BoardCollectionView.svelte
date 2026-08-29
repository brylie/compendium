<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { nanoid } from 'nanoid';
	import { getClientDoc } from '$lib/client/yjs-client';
	import { CURRENT_USER } from '$lib/client/actor';
	import {
		createRecord,
		deleteRecord,
		updateCollectionSchema,
		updateRecordProperties
	} from '$lib/data/records';
	import {
		getCollectionView,
		groupBySelectProperty,
		projectRecords,
		visibleProperties
	} from '$lib/data/views';
	import type { ViewConfig, BoardColumn } from '$lib/data/views';
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

	const UNASSIGNED_KEY = '__unassigned__';

	let ydoc: ReturnType<typeof getClientDoc> | undefined = $state();
	let schema: PropertyDefinition[] = $state([]);
	let rows: WorkspaceRecord[] = $state([]);
	let manualOrder: Record<string, string[]> = $state({});
	let draggedRecordId: string | null = $state(null);
	let newGroupingPropertyLabel = $state('Status');
	let optionDialogPropertyKey: string | null = $state(null);

	// The grouping property is config.groupBy, persisted on the embedding
	// block — see EmbeddedViewConfig in $lib/data/types. Manual per-card
	// order within a column stays local/ephemeral (not part of ViewConfig):
	// it's a much finer-grained, higher-churn kind of state than filters/
	// sort/grouping, and persisting it per-viewer would need its own design
	// (whose order wins when two people drag concurrently?) — deferred.
	const selectProperties = $derived(schema.filter((p) => p.type === 'select'));
	const groupProperty = $derived(schema.find((p) => p.key === config.groupBy));
	const projected = $derived(projectRecords(rows, config));
	const columns = $derived<BoardColumn[]>(
		groupProperty ? groupBySelectProperty(projected, groupProperty) : []
	);
	const titlePropertyKey = $derived(schema.find((p) => p.type === 'text')?.key);
	const titleProperty = $derived(schema.find((p) => p.key === titlePropertyKey));
	const cardFields = $derived(
		visibleProperties(schema, config).filter(
			(p) => p.key !== config.groupBy && p.key !== titlePropertyKey
		)
	);

	// Auto-picking a default groupBy is attempted at most once per
	// collectionId, not on every refresh — refresh() re-runs on every Yjs
	// change (including the auto-pick's own write), so re-attempting it each
	// time would loop forever whenever config never actually changes back
	// (e.g. no select property exists yet, so resolvedKey stays undefined).
	let autoGroupByAttempted = false;

	function refresh(): void {
		if (!ydoc) return;
		const view = getCollectionView(ydoc, collectionId);
		schema = view.collection?.schema ?? [];
		rows = view.records;
		if (autoGroupByAttempted) return;
		autoGroupByAttempted = true;
		const resolvedKey =
			config.groupBy && schema.some((p) => p.key === config.groupBy && p.type === 'select')
				? config.groupBy
				: schema.find((p) => p.type === 'select')?.key;
		if (resolvedKey !== config.groupBy) {
			onConfigChange({ ...config, groupBy: resolvedKey });
		}
	}

	onMount(() => {
		const doc = getClientDoc();
		ydoc = doc;

		const recordsMap = doc.getMap('records');
		const collectionsMap = doc.getMap('collections');
		const observer = () => refresh();
		recordsMap.observeDeep(observer);
		collectionsMap.observeDeep(observer);

		return () => {
			recordsMap.unobserveDeep(observer);
			collectionsMap.unobserveDeep(observer);
		};
	});

	$effect(() => {
		void collectionId;
		autoGroupByAttempted = false;
		untrack(() => refresh());
	});

	function addGroupingProperty(): void {
		if (!ydoc) return;
		const label = newGroupingPropertyLabel.trim();
		if (!label) return;
		const property: PropertyDefinition = { key: nanoid(8), label, type: 'select', options: [] };
		updateCollectionSchema(ydoc, collectionId, [...schema, property]);
		onConfigChange({ ...config, groupBy: property.key });
	}

	function addSelectOption(propertyKey: string, rawLabel: string): void {
		if (!ydoc) return;
		const label = rawLabel?.trim();
		if (!label) return;
		const nextSchema = schema.map((p) =>
			p.key === propertyKey
				? { ...p, options: [...(p.options ?? []), { id: nanoid(6), label }] }
				: p
		);
		updateCollectionSchema(ydoc, collectionId, nextSchema);
	}

	function addColumnOption(): void {
		if (!groupProperty) return;
		optionDialogPropertyKey = groupProperty.key;
	}

	function openSelectOptionDialog(propertyKey: string): void {
		optionDialogPropertyKey = propertyKey;
	}

	function addCard(column: BoardColumn): void {
		if (!ydoc || !groupProperty) return;
		const properties: Record<string, PropertyValue> = {};
		if (column.optionId) properties[groupProperty.key] = { type: 'select', value: column.optionId };
		createRecord(ydoc, { parentId: collectionId, properties }, CURRENT_USER);
	}

	function removeCard(id: string): void {
		if (!ydoc) return;
		deleteRecord(ydoc, id);
	}

	function setCell(row: WorkspaceRecord, property: PropertyDefinition, value: PropertyValue): void {
		if (!ydoc) return;
		updateRecordProperties(ydoc, row.id, { [property.key]: value }, CURRENT_USER);
	}

	function cardTitle(row: WorkspaceRecord): string {
		const value = titlePropertyKey ? row.properties?.[titlePropertyKey] : undefined;
		return value?.type === 'text' && value.value ? value.value : 'Untitled';
	}

	function moveToColumn(column: BoardColumn, recordId: string): void {
		if (!ydoc || !groupProperty) return;
		updateRecordProperties(
			ydoc,
			recordId,
			{ [groupProperty.key]: { type: 'select', value: column.optionId ?? '' } },
			CURRENT_USER
		);
	}

	// Scoped by the grouping property too — switching which property drives
	// columns must not resurrect a stale manual order saved under the
	// previous property's "unassigned" bucket (both share UNASSIGNED_KEY).
	function orderKey(column: BoardColumn): string {
		return `${config.groupBy ?? ''}:${column.optionId ?? UNASSIGNED_KEY}`;
	}

	function orderedRecords(column: BoardColumn): WorkspaceRecord[] {
		if (config.sort?.mode !== 'manual') return column.records;
		const key = orderKey(column);
		const order = manualOrder[key];
		if (!order) return column.records;
		const byId = new Map(column.records.map((r) => [r.id, r]));
		const ordered = order.map((id) => byId.get(id)).filter((r): r is WorkspaceRecord => !!r);
		const missing = column.records.filter((r) => !order.includes(r.id));
		return [...ordered, ...missing];
	}

	function handleDragStart(recordId: string): void {
		draggedRecordId = recordId;
	}

	function handleColumnDrop(event: DragEvent, column: BoardColumn): void {
		event.preventDefault();
		if (!draggedRecordId) return;
		moveToColumn(column, draggedRecordId);
		draggedRecordId = null;
	}

	function handleCardDrop(event: DragEvent, column: BoardColumn, targetId: string): void {
		event.preventDefault();
		event.stopPropagation();
		if (!draggedRecordId || draggedRecordId === targetId) return;
		moveToColumn(column, draggedRecordId);
		const key = orderKey(column);
		const currentOrder = manualOrder[key] ?? column.records.map((r) => r.id);
		const withoutDragged = currentOrder.filter((id) => id !== draggedRecordId);
		const targetIndex = withoutDragged.indexOf(targetId);
		withoutDragged.splice(
			targetIndex === -1 ? withoutDragged.length : targetIndex,
			0,
			draggedRecordId
		);
		manualOrder = { ...manualOrder, [key]: withoutDragged };
		draggedRecordId = null;
	}
</script>

{#if selectProperties.length === 0}
	<div class="rounded-lg border border-dashed border-border bg-surface/50 p-8 text-center">
		<p class="text-sm text-muted">
			Board view groups records by a <strong>select</strong> property, and this collection doesn't have
			one yet.
		</p>
		<form
			class="mt-3 flex flex-wrap justify-center gap-2"
			onsubmit={(event) => {
				event.preventDefault();
				addGroupingProperty();
			}}
		>
			<label class="sr-only" for="board-new-group-property-{collectionId}"
				>Select property name</label
			>
			<input
				id="board-new-group-property-{collectionId}"
				type="text"
				bind:value={newGroupingPropertyLabel}
				class="min-w-40 rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg focus:border-accent focus:outline-none"
			/>
			<button
				type="submit"
				disabled={!newGroupingPropertyLabel.trim()}
				class="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
			>
				<Icon name="plus" size={14} />
				<span>Add a select property</span>
			</button>
		</form>
	</div>
{:else}
	<div class="mb-4 flex items-center gap-2">
		<label class="text-xs text-muted" for="board-group-property-{collectionId}">Group by</label>
		<select
			id="board-group-property-{collectionId}"
			value={config.groupBy}
			onchange={(e) =>
				onConfigChange({ ...config, groupBy: (e.target as HTMLSelectElement).value })}
			class="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus:border-accent focus:outline-none"
		>
			{#each selectProperties as property (property.key)}
				<option value={property.key}>{property.label}</option>
			{/each}
		</select>
	</div>

	<ViewToolbar {schema} bind:config={() => config, onConfigChange} />

	<div class="flex gap-4 overflow-x-auto pb-4">
		{#each columns as column (column.optionId ?? UNASSIGNED_KEY)}
			<div
				class="w-72 flex-shrink-0 rounded-lg border border-border bg-surface/40"
				role="group"
				aria-label="{column.label} column"
				ondragover={(e) => e.preventDefault()}
				ondrop={(e) => handleColumnDrop(e, column)}
			>
				<div class="flex items-center justify-between border-b border-border px-3 py-2">
					<div class="flex items-center gap-1.5">
						{#if column.color}
							<span class="h-2 w-2 rounded-full" style="background-color: {column.color}"></span>
						{/if}
						<span class="text-sm font-semibold text-fg">{column.label}</span>
						<span class="text-xs text-muted">{column.records.length}</span>
					</div>
					<button
						type="button"
						onclick={() => addCard(column)}
						class="rounded p-1 text-muted hover:bg-surface hover:text-accent"
						title="Add card"
						aria-label="Add card to {column.label}"
					>
						<Icon name="plus" size={14} />
					</button>
				</div>

				<div class="space-y-2 p-2" role="list">
					{#each orderedRecords(column) as row (row.id)}
						<div
							class="group rounded-md border border-border bg-bg p-2.5 shadow-xs transition-colors hover:border-accent/50"
							draggable="true"
							role="listitem"
							ondragstart={() => handleDragStart(row.id)}
							ondragover={(e) => e.preventDefault()}
							ondrop={(e) => handleCardDrop(e, column, row.id)}
						>
							<div class="mb-1.5 flex items-start justify-between gap-2">
								{#if titleProperty}
									<div class="flex-1">
										<PropertyValueCell
											property={titleProperty}
											value={row.properties?.[titleProperty.key]}
											oninput={(value) => setCell(row, titleProperty, value)}
										/>
									</div>
								{:else}
									<span class="text-sm font-medium text-fg">{cardTitle(row)}</span>
								{/if}
								<button
									type="button"
									onclick={() => removeCard(row.id)}
									class="p-0.5 text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-500"
									title="Delete card"
									aria-label="Delete card"
								>
									<Icon name="trash" size={12} />
								</button>
							</div>
							<label class="sr-only" for="move-{row.id}">Move {cardTitle(row)} to column</label>
							<select
								id="move-{row.id}"
								class="mb-1 w-full rounded border border-border bg-bg px-1.5 py-0.5 text-xs text-fg"
								value={column.optionId ?? UNASSIGNED_KEY}
								onchange={(e) => {
									const targetKey = (e.target as HTMLSelectElement).value;
									const target = columns.find((c) => (c.optionId ?? UNASSIGNED_KEY) === targetKey);
									if (target) moveToColumn(target, row.id);
								}}
							>
								{#each columns as c (c.optionId ?? UNASSIGNED_KEY)}
									<option value={c.optionId ?? UNASSIGNED_KEY}>{c.label}</option>
								{/each}
							</select>
							{#each cardFields as property (property.key)}
								<div class="mt-1">
									<PropertyValueCell
										{property}
										value={row.properties?.[property.key]}
										oninput={(value) => setCell(row, property, value)}
										onAddOption={() => openSelectOptionDialog(property.key)}
										compact
									/>
								</div>
							{/each}
						</div>
					{:else}
						<p class="px-1 py-2 text-xs text-muted italic">No cards.</p>
					{/each}
				</div>
			</div>
		{/each}

		<button
			type="button"
			onclick={addColumnOption}
			class="h-fit flex-shrink-0 rounded-lg border border-dashed border-border px-4 py-2.5 text-xs text-muted transition-colors hover:border-accent hover:text-accent"
		>
			+ Add column
		</button>
	</div>
{/if}

<PromptDialog
	open={optionDialogPropertyKey !== null}
	title={optionDialogPropertyKey === groupProperty?.key ? 'New column' : 'New option'}
	label={optionDialogPropertyKey === groupProperty?.key ? 'Column name' : 'Option name'}
	placeholder={optionDialogPropertyKey === groupProperty?.key ? 'Column name' : 'Option name'}
	submitLabel="Add"
	onSubmit={(value) => {
		if (optionDialogPropertyKey) addSelectOption(optionDialogPropertyKey, value);
		optionDialogPropertyKey = null;
	}}
	onCancel={() => (optionDialogPropertyKey = null)}
/>
