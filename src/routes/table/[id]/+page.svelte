<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { nanoid } from 'nanoid';
	import { getClientDoc } from '$lib/client/yjs-client';
	import { CURRENT_USER } from '$lib/client/actor';
	import {
		createRecord,
		deleteRecord,
		getCollection,
		listRecordsForParent,
		updateCollectionSchema,
		updateCollectionTitle,
		updateRecordProperties
	} from '$lib/data/records';
	import type {
		PropertyDefinition,
		PropertyType,
		PropertyValue,
		WorkspaceRecord
	} from '$lib/data/types';
	import Icon from '$lib/components/Icon.svelte';
	import PropertyValueCell from '$lib/components/PropertyValueCell.svelte';
	import ViewSwitcher from '$lib/components/ViewSwitcher.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let ydoc: ReturnType<typeof getClientDoc> | undefined = $state();
	let currentCollection = $derived(ydoc ? getCollection(ydoc, data.collectionId) : undefined);
	let title = $derived(currentCollection?.title ?? data.title);
	let schema: PropertyDefinition[] = $state([]);
	let rows: WorkspaceRecord[] = $state([]);
	let newPropertyLabel = $state('');
	let newPropertyType: PropertyType = $state('text');

	const PROPERTY_TYPES: PropertyType[] = [
		'text',
		'number',
		'date',
		'select',
		'checkbox',
		'relation'
	];

	function refresh(): void {
		if (!ydoc) return;
		const collection = getCollection(ydoc, data.collectionId);
		schema = collection?.schema ?? [];
		rows = listRecordsForParent(ydoc, data.collectionId);
	}

	onMount(() => {
		const doc = getClientDoc();
		ydoc = doc;
		refresh();

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

	function handleTitleInput(event: Event): void {
		if (!ydoc) return;
		title = (event.target as HTMLInputElement).value;
		updateCollectionTitle(ydoc, data.collectionId, title);
	}

	function addProperty(): void {
		if (!ydoc || !newPropertyLabel.trim()) return;
		const property: PropertyDefinition = {
			key: nanoid(8),
			label: newPropertyLabel.trim(),
			type: newPropertyType,
			options: newPropertyType === 'select' ? [] : undefined
		};
		updateCollectionSchema(ydoc, data.collectionId, [...schema, property]);
		newPropertyLabel = '';
	}

	function removeProperty(key: string): void {
		if (!ydoc) return;
		updateCollectionSchema(
			ydoc,
			data.collectionId,
			schema.filter((p) => p.key !== key)
		);
	}

	function addSelectOption(propertyKey: string): void {
		if (!ydoc) return;
		const label = window.prompt('New option label:');
		if (!label) return;
		const nextSchema = schema.map((p) =>
			p.key === propertyKey
				? { ...p, options: [...(p.options ?? []), { id: nanoid(6), label }] }
				: p
		);
		updateCollectionSchema(ydoc, data.collectionId, nextSchema);
	}

	function addRow(): void {
		if (!ydoc) return;
		createRecord(ydoc, { parentId: data.collectionId, properties: {} }, CURRENT_USER);
	}

	function removeRow(id: string): void {
		if (!ydoc) return;
		deleteRecord(ydoc, id);
	}

	function setCell(row: WorkspaceRecord, property: PropertyDefinition, value: PropertyValue): void {
		if (!ydoc) return;
		updateRecordProperties(ydoc, row.id, { [property.key]: value }, CURRENT_USER);
	}

	function cellValue(
		row: WorkspaceRecord,
		property: PropertyDefinition
	): PropertyValue | undefined {
		return row.properties?.[property.key];
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

	<ViewSwitcher collectionId={data.collectionId} active="table" />

	<!-- Table Canvas -->
	<div class="overflow-x-auto rounded-lg border border-border bg-bg shadow-xs">
		<table class="w-full border-collapse text-left text-sm">
			<thead>
				<tr
					class="border-b border-border bg-surface text-xs font-semibold tracking-wider text-muted"
				>
					{#each schema as property (property.key)}
						<th class="border-r border-border/60 px-3.5 py-2.5">
							<div class="flex items-center justify-between gap-2">
								<span class="font-medium text-fg">{property.label}</span>
								<div class="flex items-center gap-1.5">
									<span
										class="py-0.2 rounded border border-border bg-bg px-1 font-mono text-[10px] text-muted"
									>
										{property.type}
									</span>
									<button
										type="button"
										onclick={() => removeProperty(property.key)}
										class="rounded p-0.5 text-muted hover:text-red-500"
										title="Remove column"
										aria-label="Remove column"
									>
										×
									</button>
								</div>
							</div>
						</th>
					{/each}
					<th class="w-12 px-3 py-2.5"></th>
				</tr>
			</thead>
			<tbody class="divide-y divide-border">
				{#each rows as row (row.id)}
					<tr class="group transition-colors hover:bg-surface/40">
						{#each schema as property (property.key)}
							<td class="border-r border-border/60 p-1.5">
								<PropertyValueCell
									{property}
									value={cellValue(row, property)}
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
						<td colspan={schema.length + 1} class="py-6 text-center text-sm text-muted italic">
							No rows in this collection.
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<div class="mt-4 flex items-center gap-3">
		<button
			type="button"
			onclick={addRow}
			class="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent hover:text-accent"
		>
			<Icon name="plus" size={13} />
			<span>Add row</span>
		</button>
	</div>

	<!-- Schema Editor -->
	<section class="mt-10 rounded-lg border border-border bg-surface/50 p-5">
		<h2 class="font-display text-base font-semibold text-fg">Add Property Column</h2>
		<div class="mt-3 flex flex-wrap gap-2">
			<input
				type="text"
				placeholder="Property name…"
				bind:value={newPropertyLabel}
				class="min-w-48 rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
			/>
			<select
				bind:value={newPropertyType}
				class="rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg focus:border-accent focus:outline-none"
			>
				{#each PROPERTY_TYPES as t (t)}
					<option value={t}>{t}</option>
				{/each}
			</select>
			<button
				type="button"
				onclick={addProperty}
				class="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition-opacity hover:opacity-90"
			>
				<Icon name="plus" size={14} />
				<span>Add property</span>
			</button>
		</div>
	</section>
</div>
