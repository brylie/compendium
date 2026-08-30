<script lang="ts">
	import { tick } from 'svelte';
	import { nanoid } from 'nanoid';
	import { getClientDoc } from '$lib/client/yjs-client';
	import { getCollection, resolvePrimaryField, updateCollectionSchema } from '$lib/data/records';
	import type { PropertyDefinition, PropertyType } from '$lib/data/types';
	import Icon from './Icon.svelte';
	import FieldMenu from './FieldMenu.svelte';

	let {
		open,
		collectionId,
		onClose
	}: {
		open: boolean;
		collectionId: string;
		onClose: () => void;
	} = $props();

	const PROPERTY_TYPES: PropertyType[] = [
		'text',
		'number',
		'date',
		'select',
		'checkbox',
		'relation'
	];

	let schema: PropertyDefinition[] = $state([]);
	let primaryFieldKey: string | undefined = $state();
	let newFieldLabel = $state('');
	let newFieldType: PropertyType = $state('text');
	let errorMessage = $state('');

	const effectivePrimaryKey = $derived(resolvePrimaryField(schema, primaryFieldKey)?.key);

	let dialog: HTMLDivElement | undefined = $state();
	let closeButton: HTMLButtonElement | undefined = $state();
	let upButtons: Record<string, HTMLButtonElement | undefined> = {};
	let downButtons: Record<string, HTMLButtonElement | undefined> = {};

	function refresh(): void {
		const collection = getCollection(getClientDoc(), collectionId);
		schema = collection?.schema ?? [];
		primaryFieldKey = collection?.primaryFieldKey;
	}

	// Gated on `open` rather than a plain onMount: this dialog is mounted
	// (closed) alongside every embedded view via ViewToolbar, so touching
	// getClientDoc()/the Yjs doc unconditionally would open a live connection
	// and subscribe observers for a dialog nobody has opened yet.
	$effect(() => {
		if (!open) return;
		const doc = getClientDoc();
		refresh();
		const collectionsMap = doc.getMap('collections');
		const recordsMap = doc.getMap('records');
		const observer = () => refresh();
		collectionsMap.observeDeep(observer);
		recordsMap.observeDeep(observer);
		const previousFocus =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
		void tick().then(() => closeButton?.focus());
		return () => {
			collectionsMap.unobserveDeep(observer);
			recordsMap.unobserveDeep(observer);
			previousFocus?.focus();
		};
	});

	function moveField(index: number, direction: -1 | 1): void {
		const target = index + direction;
		if (target < 0 || target >= schema.length) return;
		const next = [...schema];
		[next[index], next[target]] = [next[target], next[index]];
		const key = schema[index].key;
		try {
			updateCollectionSchema(getClientDoc(), collectionId, next);
			// The moved field's own up/down button becomes `disabled` (and loses
			// focus to document.body) when the move lands it at either edge of
			// the list — move focus to the counterpart button on the same field
			// so a keyboard user doesn't lose their place in the list.
			if (target === 0) {
				void tick().then(() => downButtons[key]?.focus());
			} else if (target === next.length - 1) {
				void tick().then(() => upButtons[key]?.focus());
			}
		} catch {
			errorMessage = 'Could not reorder fields. Please try again.';
		}
	}

	function addField(event: SubmitEvent): void {
		event.preventDefault();
		const label = newFieldLabel.trim();
		if (!label) return;
		const field: PropertyDefinition = {
			key: nanoid(8),
			label,
			type: newFieldType,
			options: newFieldType === 'select' ? [] : undefined
		};
		try {
			updateCollectionSchema(getClientDoc(), collectionId, [...schema, field]);
			newFieldLabel = '';
			newFieldType = 'text';
			errorMessage = '';
		} catch {
			errorMessage = 'Could not add the field. Please try again.';
		}
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.stopPropagation();
			onClose();
			return;
		}
		if (event.key !== 'Tab' || !dialog) return;
		const focusable = Array.from(
			dialog.querySelectorAll<HTMLElement>(
				'button:not([disabled]), input:not([disabled]), select:not([disabled])'
			)
		);
		const first = focusable[0];
		const last = focusable.at(-1);
		if (!first || !last) return;
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}
</script>

{#if open}
	<div
		class="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
		role="presentation"
		onclick={(event) => {
			if (event.target === event.currentTarget) onClose();
		}}
	>
		<div
			bind:this={dialog}
			role="dialog"
			aria-modal="true"
			aria-labelledby="field-manager-title"
			tabindex="-1"
			class="w-full max-w-xl rounded-lg border border-border bg-bg p-5 shadow-xl"
			onkeydown={handleKeydown}
		>
			<div class="flex items-center justify-between">
				<h2 id="field-manager-title" class="text-lg font-semibold text-fg">Manage fields</h2>
				<button
					type="button"
					bind:this={closeButton}
					onclick={onClose}
					class="rounded p-1 text-muted hover:text-fg"
					aria-label="Close"
				>
					<Icon name="close" size={16} />
				</button>
			</div>

			<ul class="mt-4 max-h-96 divide-y divide-border overflow-y-auto" role="list">
				{#each schema as property, index (property.key)}
					<li class="flex items-center gap-2 px-1 py-2 hover:bg-surface/50">
						<div class="flex flex-col">
							<button
								type="button"
								bind:this={upButtons[property.key]}
								onclick={() => moveField(index, -1)}
								disabled={index === 0}
								class="text-muted hover:text-fg disabled:opacity-30"
								aria-label="Move {property.label} up"
							>
								<Icon name="arrow-up" size={11} />
							</button>
							<button
								type="button"
								bind:this={downButtons[property.key]}
								onclick={() => moveField(index, 1)}
								disabled={index === schema.length - 1}
								class="text-muted hover:text-fg disabled:opacity-30"
								aria-label="Move {property.label} down"
							>
								<Icon name="arrow-down" size={11} />
							</button>
						</div>
						<span class="flex flex-1 items-center gap-1 truncate text-sm text-fg">
							{property.label}
							{#if property.key === effectivePrimaryKey}
								<Icon name="star" size={11} class="text-accent" />
								<span class="sr-only">Primary field</span>
							{/if}
						</span>
						<span
							class="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted"
						>
							{property.type}
						</span>
						<FieldMenu {collectionId} {schema} {property} {primaryFieldKey} />
					</li>
				{:else}
					<li class="py-4 text-center text-sm text-muted italic">No fields yet.</li>
				{/each}
			</ul>

			<form class="mt-4 flex flex-wrap gap-2 border-t border-border pt-4" onsubmit={addField}>
				<label class="sr-only" for="field-manager-new-label-{collectionId}">Field name</label>
				<input
					id="field-manager-new-label-{collectionId}"
					type="text"
					placeholder="Field name…"
					bind:value={newFieldLabel}
					class="min-w-40 flex-1 rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
				/>
				<label class="sr-only" for="field-manager-new-type-{collectionId}">Field type</label>
				<select
					id="field-manager-new-type-{collectionId}"
					bind:value={newFieldType}
					class="rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg focus:border-accent focus:outline-none"
				>
					{#each PROPERTY_TYPES as t (t)}
						<option value={t}>{t}</option>
					{/each}
				</select>
				<button
					type="submit"
					disabled={!newFieldLabel.trim()}
					class="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
				>
					<Icon name="plus" size={14} />
					<span>Add field</span>
				</button>
			</form>

			{#if errorMessage}
				<p class="mt-2 text-sm text-red-600" role="alert">{errorMessage}</p>
			{/if}
		</div>
	</div>
{/if}
