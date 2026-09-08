<script lang="ts">
	import type * as Y from 'yjs';
	import { resolve } from '$app/paths';
	import { formatActor, formatTimestamp } from '$lib/data/format';
	import { resolvePrimaryField } from '$lib/data/collection-ops';
	import { listRelationBacklinks, primaryFieldDisplayValue } from '$lib/data/views';
	import {
		addCollectionSelectOption,
		removeCollectionRow,
		setCollectionCell
	} from '$lib/client/collection-editor';
	import type {
		CollectionMeta,
		PropertyDefinition,
		PropertyValue,
		WorkspaceRecord
	} from '$lib/data/types';
	import Icon from './Icon.svelte';
	import PropertyValueCell from './PropertyValueCell.svelte';
	import PromptDialog from './PromptDialog.svelte';
	import RecordBacklinkSource from './RecordBacklinkSource.svelte';

	// The side-pane surface for opening a Collection record from Table, Board,
	// or Calendar without navigating away from that view (issue #154, see
	// collection-views.md §11). Renders exactly the schema properties the
	// Collection actually defines — no forced title/body field of its own —
	// plus relation backlinks and createdBy/lastEditedBy attribution. Every
	// prop below is read from data the caller (a *CollectionView.svelte
	// renderer) already holds live via its own useCollectionView/
	// useCollectionConnection, so the pane introduces no second data path: an
	// edit made here calls the identical setCollectionCell primitive the
	// originating grid/board/calendar cell would, and both re-render off the
	// same Yjs observer the instant it commits.
	let {
		recordId,
		collectionId,
		collectionTitle,
		schema,
		rows,
		primaryFieldKey,
		ydoc,
		collections,
		onClose
	}: {
		recordId: string;
		collectionId: string;
		collectionTitle: string;
		schema: PropertyDefinition[];
		rows: WorkspaceRecord[];
		primaryFieldKey: string | undefined;
		ydoc: Y.Doc | undefined;
		collections: CollectionMeta[];
		onClose: () => void;
	} = $props();

	const record = $derived(rows.find((r) => r.id === recordId));
	const titleProperty = $derived(resolvePrimaryField(schema, primaryFieldKey));
	const otherProperties = $derived(schema.filter((p) => p.key !== titleProperty?.key));

	// Same-Collection backlinks (often self-referencing, e.g. a task's "blocks"/
	// "blocked by" relation) read straight off the rows/schema this pane's
	// caller already has connected — no extra shard connection needed. A
	// candidate Collection is anything else in the workspace whose schema has
	// a relation field explicitly targeting this Collection; only those get
	// resolved (RecordBacklinkSource, on demand) since there's no reverse-
	// relation index to consult instead (collection-views.md §11).
	const sameCollectionBacklinks = $derived(listRelationBacklinks(rows, schema, recordId));
	const otherCollectionCandidates = $derived(
		collections.filter(
			(c) =>
				c.id !== collectionId &&
				c.schema.some((p) => p.type === 'relation' && p.targetCollectionId === collectionId)
		)
	);
	const hasAnyBacklinks = $derived(
		sameCollectionBacklinks.length > 0 || otherCollectionCandidates.length > 0
	);

	let optionDialogPropertyKey: string | null = $state(null);
	let optionDialogError = $state('');
	let panelEl: HTMLDivElement | undefined = $state();

	$effect(() => {
		// Move focus into the pane on open, mirroring DocumentOutline.svelte's
		// own non-modal side-panel convention — it never traps focus (the
		// underlying view stays interactive), just starts it inside the panel.
		panelEl?.focus();
	});

	function setCell(property: PropertyDefinition, value: PropertyValue): void {
		setCollectionCell(ydoc, recordId, { [property.key]: value });
	}

	function addSelectOption(propertyKey: string, rawLabel: string): void {
		const result = addCollectionSelectOption(ydoc, collectionId, propertyKey, rawLabel);
		if (result.ok) {
			optionDialogPropertyKey = null;
			optionDialogError = '';
		} else {
			optionDialogError = result.error;
		}
	}

	function openSelectOptionDialog(propertyKey: string): void {
		optionDialogPropertyKey = propertyKey;
		optionDialogError = '';
	}

	function deleteRecord(): void {
		removeCollectionRow(ydoc, recordId);
		onClose();
	}

	// A plain top-level Escape (nothing else — a select/text-input's own
	// Escape handling, if any, still runs first via normal event order) closes
	// the pane, mirroring ConfirmDialog/FieldManagerDialog's own convention —
	// bound via svelte:window rather than a keydown listener on the panel div
	// itself, since this is a non-modal `role="region"` panel (DocumentOutline's
	// own precedent), not a `role="dialog"`, and only exists in the DOM while
	// open in the first place.
	function handleWindowKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') onClose();
	}
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div
	bind:this={panelEl}
	tabindex="-1"
	role="region"
	aria-label="Record details"
	class="fixed top-0 right-0 z-40 flex h-full w-96 flex-col border-l border-border bg-sidebar-bg shadow-lg focus:outline-none"
>
	<div class="flex items-center justify-between border-b border-border px-3 py-2.5">
		<h2 class="truncate text-sm font-semibold text-fg">{collectionTitle || 'Untitled'}</h2>
		<button
			type="button"
			onclick={onClose}
			class="rounded p-1 text-muted hover:bg-surface hover:text-fg"
			aria-label="Close record details"
		>
			<Icon name="close" size={16} />
		</button>
	</div>

	{#if !record}
		<div class="flex flex-1 items-center justify-center p-6 text-center">
			<p class="text-sm text-muted italic">This record was deleted.</p>
		</div>
	{:else}
		<div class="flex-1 overflow-y-auto p-4">
			{#if titleProperty}
				<div class="mb-4">
					<span class="mb-1 flex items-center gap-1 text-xs font-medium text-muted">
						{titleProperty.label}
						<Icon name="star" size={10} class="text-accent" />
						<span class="sr-only">Primary field</span>
					</span>
					<div class="rounded-md border border-border bg-bg px-1">
						<PropertyValueCell
							property={titleProperty}
							value={record.properties?.[titleProperty.key]}
							oninput={(value) => setCell(titleProperty, value)}
							onAddOption={() => openSelectOptionDialog(titleProperty.key)}
						/>
					</div>
				</div>
			{/if}

			<dl class="space-y-3">
				{#each otherProperties as property (property.key)}
					<div>
						<dt class="mb-1 text-xs font-medium text-muted">{property.label}</dt>
						<dd class="rounded-md border border-border bg-bg px-1">
							<PropertyValueCell
								{property}
								value={record.properties?.[property.key]}
								oninput={(value) => setCell(property, value)}
								onAddOption={() => openSelectOptionDialog(property.key)}
							/>
						</dd>
					</div>
				{:else}
					<p class="text-xs text-muted italic">This collection has no other properties.</p>
				{/each}
			</dl>

			{#if hasAnyBacklinks}
				<div class="mt-5 border-t border-border pt-3">
					<h3 class="mb-1.5 text-xs font-semibold tracking-wider text-muted uppercase">
						Referenced by
					</h3>
					<ul role="list" class="space-y-0.5">
						{#each sameCollectionBacklinks as backlink (backlink.record.id + ':' + backlink.property.key)}
							<li class="flex items-center justify-between gap-2 rounded px-2 py-1 text-xs">
								<span class="truncate text-fg">
									{primaryFieldDisplayValue(
										titleProperty ? backlink.record.properties?.[titleProperty.key] : undefined,
										titleProperty
									) || 'Untitled'}
								</span>
								<span class="flex-shrink-0 text-muted">{backlink.property.label}</span>
							</li>
						{/each}
						{#each otherCollectionCandidates as candidate (candidate.id)}
							<RecordBacklinkSource collection={candidate} targetRecordId={recordId} />
						{/each}
					</ul>
				</div>
			{/if}

			<div class="mt-5 border-t border-border pt-3 text-[11px] text-muted">
				<p>
					Created by {formatActor(record.createdBy)} · {formatTimestamp(record.createdAt)}
				</p>
				<a
					href="{resolve('/audit')}?targetRecordId={encodeURIComponent(record.id)}"
					class="underline-offset-2 hover:text-accent hover:underline"
					aria-label="Last edited by {formatActor(record.lastEditedBy)} at {formatTimestamp(
						record.lastEditedAt
					)}. Open audit history for this record."
				>
					Last edited by {formatActor(record.lastEditedBy)} · {formatTimestamp(record.lastEditedAt)}
				</a>
			</div>
		</div>

		<div class="border-t border-border p-3">
			<button
				type="button"
				onclick={deleteRecord}
				class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted transition-colors hover:text-red-500"
			>
				<Icon name="trash" size={13} />
				<span>Delete record</span>
			</button>
		</div>
	{/if}
</div>

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
