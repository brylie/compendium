<script lang="ts">
	import type * as Y from 'yjs';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { getShardDoc } from '$lib/client/yjs-client';
	import { CURRENT_USER } from '$lib/client/actor';
	import {
		addSelectOption as addSelectOptionToSchema,
		createRecord,
		deleteRecord,
		resolvePrimaryField,
		updateRecordProperties,
		ValidationError
	} from '$lib/data/records';
	import {
		computeFieldSummary,
		fieldSummaryLabel,
		getCollectionView,
		projectRecords,
		summaryOptionsForType,
		visibleProperties
	} from '$lib/data/views';
	import type { ViewConfig } from '$lib/data/views';
	import type {
		FieldSummaryType,
		PropertyDefinition,
		PropertyValue,
		WorkspaceRecord
	} from '$lib/data/types';
	import Icon from './Icon.svelte';
	import PropertyValueCell from './PropertyValueCell.svelte';
	import ViewToolbar from './ViewToolbar.svelte';
	import PromptDialog from './PromptDialog.svelte';
	import FieldMenu from './FieldMenu.svelte';

	let {
		collectionId,
		config,
		onConfigChange
	}: {
		collectionId: string;
		config: ViewConfig;
		onConfigChange: (config: ViewConfig) => void;
	} = $props();

	let ydoc: Y.Doc | undefined = $state();
	let shardId: string | undefined = $state();
	let schema: PropertyDefinition[] = $state([]);
	let rows: WorkspaceRecord[] = $state([]);
	let primaryFieldKey: string | undefined = $state();
	let optionDialogPropertyKey: string | null = $state(null);
	let optionDialogError = $state('');

	const columns = $derived(visibleProperties(schema, config));
	const projected = $derived(projectRecords(rows, schema, config));
	const effectivePrimaryKey = $derived(resolvePrimaryField(schema, primaryFieldKey)?.key);

	function refresh(): void {
		if (!ydoc) return;
		const view = getCollectionView(ydoc, collectionId);
		schema = view.collection?.schema ?? [];
		rows = view.records;
		primaryFieldKey = view.collection?.primaryFieldKey;
	}

	// Resolves this Collection's real shard (#120) — never assumed equal to
	// collectionId, since a Collection created before the shard-assignment
	// cutover still resolves to the default shard — and (re)connects
	// whenever collectionId changes (a component instance can be retargeted
	// to a different Collection without remounting, e.g. via
	// CollectionViewBlock's change-embed flow).
	$effect(() => {
		const id = collectionId;
		let cancelled = false;
		let cleanup: (() => void) | undefined;

		(async () => {
			const res = await fetch(`/api/collections/${id}/shard`);
			const { shardId: resolvedShardId } = await res.json();
			if (cancelled) return;

			shardId = resolvedShardId;
			const doc = getShardDoc(resolvedShardId);
			ydoc = doc;

			const recordsMap = doc.getMap('records');
			const collectionsMap = doc.getMap('collections');
			const observer = () => refresh();
			recordsMap.observeDeep(observer);
			collectionsMap.observeDeep(observer);
			refresh();

			cleanup = () => {
				recordsMap.unobserveDeep(observer);
				collectionsMap.unobserveDeep(observer);
			};
		})();

		return () => {
			cancelled = true;
			cleanup?.();
		};
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

	function addSelectOption(propertyKey: string, rawLabel: string): void {
		if (!ydoc) return;
		try {
			addSelectOptionToSchema(ydoc, collectionId, propertyKey, rawLabel);
			optionDialogPropertyKey = null;
			optionDialogError = '';
		} catch (err) {
			optionDialogError =
				err instanceof ValidationError
					? err.message
					: 'Could not add the option. Please try again.';
		}
	}

	function openSelectOptionDialog(propertyKey: string): void {
		optionDialogPropertyKey = propertyKey;
		optionDialogError = '';
	}

	// A column is only ever rendered here when it's visible (columns already
	// filters via visibleProperties), so this only ever needs to hide —
	// re-showing a hidden field goes through ViewToolbar's own "Fields" panel,
	// which is the one place that can see and toggle a currently-hidden field.
	function hideInThisView(propertyKey: string): void {
		const current = config.visibleProperties ?? schema.map((p) => p.key);
		onConfigChange({ ...config, visibleProperties: current.filter((k) => k !== propertyKey) });
	}

	function setSummary(propertyKey: string, type: FieldSummaryType): void {
		const next = { ...(config.summaries ?? {}) };
		if (type === 'none') delete next[propertyKey];
		else next[propertyKey] = type;
		onConfigChange({
			...config,
			summaries: Object.keys(next).length > 0 ? next : undefined
		});
	}
</script>

{#if schema.length === 0}
	<p
		class="rounded-lg border border-dashed border-border bg-surface/50 p-6 text-center text-sm text-muted"
	>
		This collection has no properties yet — add one from the
		<a
			href={resolve('/space/[spaceId]/table/[id]', {
				spaceId: page.params.spaceId!,
				id: collectionId
			})}
			class="text-accent hover:underline">full table</a
		>.
	</p>
{:else}
	<ViewToolbar
		{collectionId}
		shardId={shardId!}
		{schema}
		bind:config={() => config, onConfigChange}
	/>

	<div class="overflow-x-auto rounded-lg border border-border bg-bg shadow-xs">
		<table class="w-full border-collapse text-left text-sm">
			<thead>
				<tr
					class="border-b border-border bg-surface text-xs font-semibold tracking-wider text-muted"
				>
					{#each columns as property (property.key)}
						<th class="border-r border-border/60 px-3.5 py-2.5">
							<div class="flex items-center justify-between gap-2">
								<span class="flex items-center gap-1 font-medium text-fg">
									{property.label}
									{#if property.key === effectivePrimaryKey}
										<Icon name="star" size={11} class="text-accent" />
										<span class="sr-only">Primary field</span>
									{/if}
								</span>
								<FieldMenu
									{collectionId}
									shardId={shardId!}
									{schema}
									{property}
									{primaryFieldKey}
									visible={true}
									onToggleVisible={() => hideInThisView(property.key)}
								/>
							</div>
						</th>
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
									onAddOption={() => openSelectOptionDialog(property.key)}
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
			<tfoot>
				<tr class="border-t border-border bg-surface/60 text-xs text-muted">
					{#each columns as property (property.key)}
						{@const summaryType = config.summaries?.[property.key] ?? 'none'}
						<td class="border-r border-border/60 px-3.5 py-2">
							<div class="flex items-center gap-1.5">
								<label class="sr-only" for="summary-{collectionId}-{property.key}"
									>{property.label} summary</label
								>
								<select
									id="summary-{collectionId}-{property.key}"
									value={summaryType}
									onchange={(e) =>
										setSummary(
											property.key,
											(e.target as HTMLSelectElement).value as FieldSummaryType
										)}
									class="rounded border border-border bg-bg px-1 py-0.5 text-[11px] text-muted"
								>
									{#each summaryOptionsForType(property.type) as opt (opt)}
										<option value={opt}>{fieldSummaryLabel(opt)}</option>
									{/each}
								</select>
								{#if summaryType !== 'none'}
									<span class="font-medium text-fg"
										>{computeFieldSummary(projected, property, summaryType)}</span
									>
								{/if}
							</div>
						</td>
					{/each}
					<td></td>
				</tr>
			</tfoot>
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
			href={resolve('/space/[spaceId]/table/[id]', {
				spaceId: page.params.spaceId!,
				id: collectionId
			})}
			class="text-xs text-muted hover:text-accent hover:underline"
		>
			Open full table →
		</a>
	</div>
{/if}

<PromptDialog
	open={optionDialogPropertyKey !== null}
	title="New option"
	label="Option name"
	placeholder="Option name"
	submitLabel="Add option"
	errorMessage={optionDialogError}
	onSubmit={(value) => {
		if (optionDialogPropertyKey) addSelectOption(optionDialogPropertyKey, value);
	}}
	onCancel={() => {
		optionDialogPropertyKey = null;
		optionDialogError = '';
	}}
/>
