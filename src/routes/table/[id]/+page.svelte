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
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let title = $state(data.title);
	let schema: PropertyDefinition[] = $state([]);
	let rows: WorkspaceRecord[] = $state([]);
	let newPropertyLabel = $state('');
	let newPropertyType: PropertyType = $state('text');

	let ydoc: ReturnType<typeof getClientDoc> | undefined = $state();

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
	<title>{title || 'Untitled'} · AgentSpace</title>
</svelte:head>

<main>
	<a class="back" href={resolve('/')}>← Workspace</a>
	<input class="title" value={title} oninput={handleTitleInput} placeholder="Untitled" />

	<div class="table-scroll">
		<table>
			<thead>
				<tr>
					{#each schema as property (property.key)}
						<th>
							{property.label}
							<span class="type">{property.type}</span>
							<button type="button" class="remove-col" onclick={() => removeProperty(property.key)}
								>×</button
							>
						</th>
					{/each}
					<th></th>
				</tr>
			</thead>
			<tbody>
				{#each rows as row (row.id)}
					<tr>
						{#each schema as property (property.key)}
							<td>
								{#if property.type === 'text'}
									<input
										type="text"
										value={(cellValue(row, property) as { value?: string })?.value ?? ''}
										onchange={(e) =>
											setCell(row, property, {
												type: 'text',
												value: (e.target as HTMLInputElement).value
											})}
									/>
								{:else if property.type === 'number'}
									<input
										type="number"
										value={(cellValue(row, property) as { value?: number })?.value ?? ''}
										onchange={(e) =>
											setCell(row, property, {
												type: 'number',
												value: Number((e.target as HTMLInputElement).value)
											})}
									/>
								{:else if property.type === 'date'}
									<input
										type="date"
										value={(cellValue(row, property) as { value?: string })?.value ?? ''}
										onchange={(e) =>
											setCell(row, property, {
												type: 'date',
												value: (e.target as HTMLInputElement).value
											})}
									/>
								{:else if property.type === 'checkbox'}
									<input
										type="checkbox"
										checked={(cellValue(row, property) as { value?: boolean })?.value ?? false}
										onchange={(e) =>
											setCell(row, property, {
												type: 'checkbox',
												value: (e.target as HTMLInputElement).checked
											})}
									/>
								{:else if property.type === 'select'}
									<select
										value={(cellValue(row, property) as { value?: string })?.value ?? ''}
										onchange={(e) =>
											setCell(row, property, {
												type: 'select',
												value: (e.target as HTMLSelectElement).value
											})}
									>
										<option value="">—</option>
										{#each property.options ?? [] as option (option.id)}
											<option value={option.id}>{option.label}</option>
										{/each}
									</select>
									<button
										type="button"
										class="add-option"
										onclick={() => addSelectOption(property.key)}>+</button
									>
								{:else if property.type === 'relation'}
									<input
										type="text"
										placeholder="record ids, comma-separated"
										value={(cellValue(row, property) as { value?: string[] })?.value?.join(', ') ??
											''}
										onchange={(e) =>
											setCell(row, property, {
												type: 'relation',
												value: (e.target as HTMLInputElement).value
													.split(',')
													.map((s) => s.trim())
													.filter(Boolean)
											})}
									/>
								{/if}
							</td>
						{/each}
						<td><button type="button" onclick={() => removeRow(row.id)}>Delete</button></td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<button type="button" class="add-row" onclick={addRow}>+ Add row</button>

	<section class="schema-editor">
		<h2>Add property</h2>
		<div class="add-property">
			<input type="text" placeholder="Property name" bind:value={newPropertyLabel} />
			<select bind:value={newPropertyType}>
				{#each PROPERTY_TYPES as t (t)}
					<option value={t}>{t}</option>
				{/each}
			</select>
			<button type="button" onclick={addProperty}>Add</button>
		</div>
	</section>
</main>

<style>
	main {
		max-width: 60rem;
		margin: 0 auto;
		padding: 2rem 1rem;
		font-family:
			system-ui,
			-apple-system,
			sans-serif;
	}
	.back {
		display: inline-block;
		margin-bottom: 1rem;
		color: #666;
		text-decoration: none;
	}
	.title {
		font-size: 2rem;
		font-weight: 700;
		border: none;
		outline: none;
		width: 100%;
		margin-bottom: 1.5rem;
	}
	.table-scroll {
		overflow-x: auto;
	}
	table {
		border-collapse: collapse;
		width: 100%;
	}
	th,
	td {
		border: 1px solid #e5e5e5;
		padding: 0.4rem 0.6rem;
		text-align: left;
		white-space: nowrap;
	}
	th {
		background: #fafafa;
		font-weight: 600;
	}
	.type {
		color: #999;
		font-weight: 400;
		font-size: 0.7rem;
		margin-left: 0.3rem;
	}
	.remove-col,
	.add-option {
		border: none;
		background: none;
		cursor: pointer;
		color: #999;
	}
	.add-row {
		margin-top: 0.75rem;
		padding: 0.4rem 0.8rem;
		border: 1px dashed #ccc;
		border-radius: 4px;
		background: none;
		cursor: pointer;
		color: #666;
	}
	.schema-editor {
		margin-top: 2rem;
	}
	.add-property {
		display: flex;
		gap: 0.5rem;
	}
</style>
