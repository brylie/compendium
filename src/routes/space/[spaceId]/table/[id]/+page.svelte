<script lang="ts">
	import { untrack } from 'svelte';
	import type * as Y from 'yjs';
	import { resolve } from '$app/paths';
	import { nanoid } from 'nanoid';
	import { getShardDoc } from '$lib/client/yjs-client';
	import { CURRENT_USER } from '$lib/client/actor';
	import { useCollectionView } from '$lib/client/collection-view.svelte';
	import {
		createRecord,
		deleteRecord,
		resolvePrimaryField,
		updateCollectionSchema,
		updateCollectionTitle,
		updateRecordProperties
	} from '$lib/data/records';
	import type { PropertyDefinition, PropertyValue, WorkspaceRecord } from '$lib/data/types';
	import Icon from '$lib/components/Icon.svelte';
	import PropertyValueCell from '$lib/components/PropertyValueCell.svelte';
	import PromptDialog from '$lib/components/PromptDialog.svelte';
	import FieldMenu from '$lib/components/FieldMenu.svelte';
	import FieldManagerDialog from '$lib/components/FieldManagerDialog.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let ydoc: Y.Doc | undefined = $state();
	let shardId: string | undefined = $state();
	// Set in lockstep with ydoc (never the raw data.collectionId) below — the
	// prop can change synchronously on navigation while ydoc only catches up
	// once the async shard fetch resolves, and useCollectionView must never
	// see a doc paired with a collectionId it doesn't belong to.
	let resolvedCollectionId: string | undefined = $state();
	let optionDialogPropertyKey: string | null = $state(null);
	let optionDialogError = $state('');
	let fieldManagerOpen = $state(false);
	// Initial-render-only snapshot of the SSR-loaded title, shown before ydoc
	// mounts; the hook's snapshot callback below keeps it in sync with the
	// Y.Doc afterwards — untrack() here just tells Svelte that's deliberate.
	// Kept as its own $state (not a $derived off the hook) because
	// handleTitleInput below needs to assign it directly for responsive
	// typing, ahead of the Yjs write's own observer round-trip.
	let title: string = $state(untrack(() => data.title));

	const view = useCollectionView(
		() => ydoc,
		() => resolvedCollectionId ?? data.collectionId,
		(snapshot) => {
			title = snapshot.collection?.title ?? data.title;
		}
	);
	const schema = $derived(view.schema);
	const rows = $derived(view.rows);
	const primaryFieldKey = $derived(view.primaryFieldKey);
	let effectivePrimaryKey = $derived(resolvePrimaryField(schema, primaryFieldKey)?.key);

	// SvelteKit reuses this component instance across client-side navigations
	// between two /table/[id] routes — this effect re-runs whenever
	// data.collectionId changes (not just on mount), resolving that
	// Collection's real shard (#120) and reconnecting to it.
	$effect(() => {
		const id = data.collectionId;
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

	function handleTitleInput(event: Event): void {
		if (!ydoc) return;
		title = (event.target as HTMLInputElement).value;
		updateCollectionTitle(ydoc, data.collectionId, title);
	}

	function addSelectOption(propertyKey: string, rawLabel: string): boolean {
		if (!ydoc) return false;
		const label = rawLabel.trim();
		if (!label) return false;
		const nextSchema = schema.map((p) =>
			p.key === propertyKey
				? { ...p, options: [...(p.options ?? []), { id: nanoid(6), label }] }
				: p
		);
		try {
			updateCollectionSchema(ydoc, data.collectionId, nextSchema);
			return true;
		} catch {
			optionDialogError = 'Could not add the option. Please try again.';
			return false;
		}
	}

	function openSelectOptionDialog(propertyKey: string): void {
		optionDialogError = '';
		optionDialogPropertyKey = propertyKey;
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
								<span class="flex items-center gap-1 font-medium text-fg">
									{property.label}
									{#if property.key === effectivePrimaryKey}
										<Icon name="star" size={11} class="text-accent" />
										<span class="sr-only">Primary field</span>
									{/if}
								</span>
								<div class="flex items-center gap-1.5">
									<span
										class="py-0.2 rounded border border-border bg-bg px-1 font-mono text-[10px] text-muted"
									>
										{property.type}
									</span>
									<FieldMenu
										collectionId={data.collectionId}
										shardId={shardId!}
										{schema}
										{property}
										{primaryFieldKey}
										collections={data.collections}
									/>
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
		<button
			type="button"
			onclick={() => (fieldManagerOpen = true)}
			class="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent hover:text-accent"
		>
			<Icon name="pencil" size={13} />
			<span>Manage fields</span>
		</button>
	</div>
</div>

<FieldManagerDialog
	open={fieldManagerOpen}
	collectionId={data.collectionId}
	shardId={shardId!}
	collections={data.collections}
	onClose={() => (fieldManagerOpen = false)}
/>

<PromptDialog
	open={optionDialogPropertyKey !== null}
	title="New option"
	label="Option name"
	placeholder="Option name"
	errorMessage={optionDialogError}
	submitLabel="Add option"
	onSubmit={(value) => {
		if (optionDialogPropertyKey && addSelectOption(optionDialogPropertyKey, value)) {
			optionDialogPropertyKey = null;
		}
	}}
	onCancel={() => (optionDialogPropertyKey = null)}
/>
