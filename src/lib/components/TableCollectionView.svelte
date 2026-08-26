<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { getClientDoc } from '$lib/client/yjs-client';
	import { CURRENT_USER } from '$lib/client/actor';
	import {
		createRecord,
		deleteRecord,
		updateCollectionSchema,
		updateRecordProperties
	} from '$lib/data/records';
	import { getCollectionView, projectRecords, visibleProperties } from '$lib/data/views';
	import type { ViewConfig } from '$lib/data/views';
	import type { PropertyDefinition, PropertyValue, WorkspaceRecord } from '$lib/data/types';
	import { nanoid } from 'nanoid';
	import Icon from './Icon.svelte';
	import PropertyValueCell from './PropertyValueCell.svelte';
	import ViewToolbar from './ViewToolbar.svelte';

	let {
		collectionId,
		config,
		onConfigChange
	}: {
		collectionId: string;
		config: ViewConfig;
		onConfigChange: (config: ViewConfig) => void;
	} = $props();

	let ydoc: ReturnType<typeof getClientDoc> | undefined = $state();
	let schema: PropertyDefinition[] = $state([]);
	let rows: WorkspaceRecord[] = $state([]);

	const columns = $derived(visibleProperties(schema, config));
	const projected = $derived(projectRecords(rows, config));

	function refresh(): void {
		if (!ydoc) return;
		const view = getCollectionView(ydoc, collectionId);
		schema = view.collection?.schema ?? [];
		rows = view.records;
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
		untrack(() => refresh());
	});

	function addRow(): void {
		if (!ydoc) return;
		createRecord(ydoc, { parentId: collectionId, properties: {} }, CURRENT_USER);
	}

	function removeRow(id: string): void {
		if (!ydoc) return;
		deleteRecord(ydoc, id);
	}

	function setCell(row: WorkspaceRecord, property: PropertyDefinition, value: PropertyValue): void {
		if (!ydoc) return;
		updateRecordProperties(ydoc, row.id, { [property.key]: value }, CURRENT_USER);
	}

	function addSelectOption(propertyKey: string): void {
		if (!ydoc) return;
		const rawLabel = window.prompt('New option label:');
		const label = rawLabel?.trim();
		if (!label) return;
		const nextSchema = schema.map((p) =>
			p.key === propertyKey
				? { ...p, options: [...(p.options ?? []), { id: nanoid(6), label }] }
				: p
		);
		updateCollectionSchema(ydoc, collectionId, nextSchema);
	}
</script>

{#if schema.length === 0}
	<p
		class="rounded-lg border border-dashed border-border bg-surface/50 p-6 text-center text-sm text-muted"
	>
		This collection has no properties yet — add one from the
		<a href={resolve('/table/[id]', { id: collectionId })} class="text-accent hover:underline"
			>full table</a
		>.
	</p>
{:else}
	<ViewToolbar {schema} bind:config={() => config, onConfigChange} />

	<div class="overflow-x-auto rounded-lg border border-border bg-bg shadow-xs">
		<table class="w-full border-collapse text-left text-sm">
			<thead>
				<tr
					class="border-b border-border bg-surface text-xs font-semibold tracking-wider text-muted"
				>
					{#each columns as property (property.key)}
						<th class="border-r border-border/60 px-3.5 py-2.5">{property.label}</th>
					{/each}
					<th class="w-12 px-3 py-2.5"></th>
				</tr>
			</thead>
			<tbody class="divide-y divide-border">
				{#each projected as row (row.id)}
					<tr class="group transition-colors hover:bg-surface/40">
						{#each columns as property (property.key)}
							<td class="border-r border-border/60 p-1.5">
								<PropertyValueCell
									{property}
									value={row.properties?.[property.key]}
									oninput={(value) => setCell(row, property, value)}
									onAddOption={() => addSelectOption(property.key)}
								/>
							</td>
						{/each}
						<td class="px-2 py-1.5 text-center">
							<button
								type="button"
								onclick={() => removeRow(row.id)}
								class="rounded p-1 text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-500"
								title="Delete row"
								aria-label="Delete row"
							>
								<Icon name="trash" size={14} />
							</button>
						</td>
					</tr>
				{:else}
					<tr>
						<td colspan={columns.length + 1} class="py-6 text-center text-sm text-muted italic">
							No rows in this collection.
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<div class="mt-3 flex items-center justify-between">
		<button
			type="button"
			onclick={addRow}
			class="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent hover:text-accent"
		>
			<Icon name="plus" size={13} />
			<span>Add row</span>
		</button>
		<a
			href={resolve('/table/[id]', { id: collectionId })}
			class="text-xs text-muted hover:text-accent hover:underline"
		>
			Open full table →
		</a>
	</div>
{/if}
