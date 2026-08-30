<script lang="ts">
	import { tick } from 'svelte';
	import { nanoid } from 'nanoid';
	import { getClientDoc } from '$lib/client/yjs-client';
	import {
		addSelectOption,
		countRecordsWithProperty,
		countRecordsWithSelectOption,
		deleteCollectionProperty,
		deleteSelectOption,
		duplicateCollectionProperty,
		moveSelectOption,
		previewCollectionPropertyTypeChange,
		updateCollectionProperty,
		updateCollectionSchema,
		updateSelectOption,
		ValidationError
	} from '$lib/data/records';
	import { SELECT_OPTION_COLORS } from '$lib/data/select-colors';
	import type { PropertyDefinition, PropertyType } from '$lib/data/types';
	import Icon from './Icon.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';

	let {
		collectionId,
		schema,
		property,
		visible = undefined,
		onToggleVisible = undefined
	}: {
		collectionId: string;
		schema: PropertyDefinition[];
		property: PropertyDefinition;
		visible?: boolean;
		onToggleVisible?: () => void;
	} = $props();

	const PROPERTY_TYPES: PropertyType[] = [
		'text',
		'number',
		'date',
		'select',
		'checkbox',
		'relation'
	];

	const MENU_WIDTH = 224; // px — matches the menu-mode panel's w-56
	const EDIT_WIDTH = 288; // px — wider, so a select field's option list has room to breathe

	let open = $state(false);
	let mode = $state<'menu' | 'edit'>('menu');
	let editLabel = $state('');
	let editType: PropertyType = $state('text');
	let confirmDeleteOpen = $state(false);
	let deleteAffectedCount = $state(0);
	let errorMessage = $state('');
	let panelStyle = $state('');

	// Select option lifecycle (issue #94) — only shown when the field is
	// already a select field (not while editType is mid-change toward one;
	// options only exist once the rename/retype form above is saved).
	const options = $derived(property.type === 'select' ? (property.options ?? []) : []);
	let newOptionLabel = $state('');
	let optionError = $state('');
	let colorPickerOptionId: string | null = $state(null);
	let draggedOptionId: string | null = $state(null);
	let dragOverOptionId: string | null = $state(null);
	let deleteOptionId: string | null = $state(null);
	let deleteOptionLabel = $state('');
	let deleteOptionAffectedCount = $state(0);

	let container: HTMLDivElement | undefined = $state();
	let trigger: HTMLButtonElement | undefined = $state();
	let panel: HTMLDivElement | undefined = $state();
	let firstMenuItem: HTMLButtonElement | undefined = $state();
	let labelInput: HTMLInputElement | undefined = $state();
	let confirmDialogs: HTMLDivElement | undefined = $state();

	// The panel is portalled to <body> (see `portal` below) rather than
	// positioned `absolute` inside `container` — Table's header lives inside
	// an `overflow-x-auto` wrapper, which (per the CSS overflow spec) forces
	// overflow-y to clip too, cutting the dropdown off whenever the table has
	// too few rows for the panel to fit above that clip boundary. `fixed`
	// positioning computed from the trigger's own viewport rect sidesteps
	// that ancestor clipping entirely.
	function portal(node: HTMLElement): { destroy(): void } {
		document.body.appendChild(node);
		return {
			destroy() {
				node.remove();
			}
		};
	}

	function updatePanelPosition(): void {
		if (!trigger) return;
		const width = mode === 'edit' ? EDIT_WIDTH : MENU_WIDTH;
		const rect = trigger.getBoundingClientRect();
		const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
		panelStyle = `position: fixed; top: ${rect.bottom + 4}px; left: ${left}px; width: ${width}px;`;
	}

	// Runs after the panel actually renders (so its real height is known) to
	// flip it above the trigger when it would otherwise overflow the bottom
	// of the viewport — the synchronous updatePanelPosition() above only has
	// the trigger's rect to go on, not the panel's own (mode-dependent) height.
	async function refinePanelPosition(): Promise<void> {
		await tick();
		if (!trigger || !panel) return;
		const width = mode === 'edit' ? EDIT_WIDTH : MENU_WIDTH;
		const rect = trigger.getBoundingClientRect();
		const panelHeight = panel.getBoundingClientRect().height;
		const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
		const overflowsBelow = rect.bottom + 4 + panelHeight > window.innerHeight - 8;
		const top = overflowsBelow ? Math.max(8, rect.top - panelHeight - 4) : rect.bottom + 4;
		panelStyle = `position: fixed; top: ${top}px; left: ${left}px; width: ${width}px;`;
	}

	// Dropdowns don't track scroll/resize continuously here — closing on
	// either (a common pattern; a native <select> does the same on scroll)
	// is simpler than keeping a stale `fixed` position glued to a trigger
	// that's moved, and avoids a scroll/resize listener recomputing layout
	// on every frame for a menu that's normally open for a couple of clicks.
	function handleWindowScrollOrResize(): void {
		if (open) closeMenu();
	}

	const typeChangePreview = $derived(
		mode === 'edit' && editType !== property.type
			? previewCollectionPropertyTypeChange(getClientDoc(), collectionId, property.key, editType)
			: { affected: 0, total: 0 }
	);

	function openMenu(): void {
		updatePanelPosition();
		open = true;
		mode = 'menu';
		errorMessage = '';
	}

	function closeMenu(): void {
		open = false;
		trigger?.focus();
	}

	function openEdit(): void {
		editLabel = property.label;
		editType = property.type;
		mode = 'edit';
	}

	function saveEdit(event: SubmitEvent): void {
		event.preventDefault();
		const label = editLabel.trim();
		if (!label) return;
		try {
			updateCollectionProperty(getClientDoc(), collectionId, property.key, {
				label: label !== property.label ? label : undefined,
				type: editType !== property.type ? editType : undefined
			});
			errorMessage = '';
			closeMenu();
		} catch {
			errorMessage = 'Could not update the field. Please try again.';
		}
	}

	function insertField(direction: 'left' | 'right'): void {
		const index = schema.findIndex((p) => p.key === property.key);
		const insertAt = direction === 'left' ? index : index + 1;
		const field: PropertyDefinition = { key: nanoid(8), label: 'New field', type: 'text' };
		const next = [...schema.slice(0, insertAt), field, ...schema.slice(insertAt)];
		try {
			updateCollectionSchema(getClientDoc(), collectionId, next);
			closeMenu();
		} catch {
			errorMessage = 'Could not insert a field. Please try again.';
		}
	}

	function duplicate(): void {
		try {
			duplicateCollectionProperty(getClientDoc(), collectionId, property.key);
			closeMenu();
		} catch {
			errorMessage = 'Could not duplicate the field. Please try again.';
		}
	}

	function toggleVisible(): void {
		onToggleVisible?.();
		closeMenu();
	}

	function openDeleteConfirm(): void {
		deleteAffectedCount = countRecordsWithProperty(getClientDoc(), collectionId, property.key);
		confirmDeleteOpen = true;
		open = false;
	}

	function confirmDelete(): void {
		try {
			deleteCollectionProperty(getClientDoc(), collectionId, property.key);
			errorMessage = '';
		} catch {
			// Close the confirmation too, not just clear it — ConfirmDialog is a
			// full-screen `fixed inset-0` overlay, so leaving it open would hide
			// the error paragraph behind it and the user would see no feedback.
			errorMessage = 'Could not delete the field. Please try again.';
		}
		confirmDeleteOpen = false;
	}

	function submitAddOption(event: SubmitEvent): void {
		event.preventDefault();
		const label = newOptionLabel.trim();
		if (!label) return;
		try {
			addSelectOption(getClientDoc(), collectionId, property.key, label);
			newOptionLabel = '';
			optionError = '';
		} catch (err) {
			optionError =
				err instanceof ValidationError
					? err.message
					: 'Could not add the option. Please try again.';
		}
	}

	// Returns whether the rename took effect, so the caller (the input's own
	// blur handler) can restore the input's displayed text to the still-
	// current stored label on rejection — value={option.label} is one-way and
	// won't touch the DOM on its own when option.label hasn't actually
	// changed, so a rejected edit would otherwise leave the invalid text
	// showing in the field indefinitely.
	function renameOption(optionId: string, rawLabel: string): boolean {
		const option = options.find((o) => o.id === optionId);
		const label = rawLabel.trim();
		if (!option || label === option.label) return true;
		try {
			updateSelectOption(getClientDoc(), collectionId, property.key, optionId, { label });
			optionError = '';
			return true;
		} catch (err) {
			optionError =
				err instanceof ValidationError
					? err.message
					: 'Could not rename the option. Please try again.';
			return false;
		}
	}

	function toggleColorPicker(optionId: string): void {
		colorPickerOptionId = colorPickerOptionId === optionId ? null : optionId;
	}

	function setOptionColor(optionId: string, color: string): void {
		try {
			updateSelectOption(getClientDoc(), collectionId, property.key, optionId, { color });
			optionError = '';
		} catch {
			optionError = 'Could not recolor the option. Please try again.';
		}
		colorPickerOptionId = null;
	}

	function moveOption(index: number, direction: -1 | 1): void {
		const option = options[index];
		if (!option) return;
		try {
			moveSelectOption(getClientDoc(), collectionId, property.key, option.id, index + direction);
			optionError = '';
		} catch (err) {
			optionError =
				err instanceof ValidationError
					? err.message
					: 'Could not reorder options. Please try again.';
		}
	}

	function handleOptionDragStart(event: DragEvent, optionId: string): void {
		draggedOptionId = optionId;
		// Firefox refuses to start a drag at all unless the dataTransfer store
		// has data set during dragstart — Chrome is lenient about an empty
		// store, Firefox isn't.
		event.dataTransfer?.setData('text/plain', optionId);
	}

	function handleOptionDrop(targetOptionId: string): void {
		const fromId = draggedOptionId;
		draggedOptionId = null;
		dragOverOptionId = null;
		if (!fromId || fromId === targetOptionId) return;
		const toIndex = options.findIndex((o) => o.id === targetOptionId);
		if (toIndex === -1) return;
		try {
			moveSelectOption(getClientDoc(), collectionId, property.key, fromId, toIndex);
			optionError = '';
		} catch (err) {
			optionError =
				err instanceof ValidationError
					? err.message
					: 'Could not reorder options. Please try again.';
		}
	}

	function openDeleteOptionConfirm(optionId: string, label: string): void {
		deleteOptionId = optionId;
		deleteOptionLabel = label;
		deleteOptionAffectedCount = countRecordsWithSelectOption(
			getClientDoc(),
			collectionId,
			property.key,
			optionId
		);
	}

	function confirmDeleteOption(): void {
		if (!deleteOptionId) return;
		try {
			deleteSelectOption(getClientDoc(), collectionId, property.key, deleteOptionId);
			optionError = '';
		} catch {
			optionError = 'Could not delete the option. Please try again.';
		}
		deleteOptionId = null;
	}

	function handleWindowClick(event: MouseEvent): void {
		if (!open || !container) return;
		// composedPath() is captured at dispatch time, before any DOM mutation —
		// unlike container.contains(event.target), it stays correct even when a
		// menu action (e.g. "Edit field") synchronously re-renders and detaches
		// the very button that was clicked before this listener runs on window.
		// The panel is checked separately since portal() moves it outside
		// `container` in the DOM (see `portal` above) — without this, clicking
		// inside the portalled panel itself would look like an outside click.
		// `confirmDialogs` is checked too: it wraps both ConfirmDialogs, which
		// render as their own fixed-overlay siblings outside container/panel —
		// without this, confirming/cancelling an option delete (deliberately
		// left open so the field editor stays open across managing several
		// options) would look like an outside click and force-close the panel,
		// swallowing optionError along with it since it only renders while open.
		const path = event.composedPath();
		if (
			!path.includes(container) &&
			!(panel && path.includes(panel)) &&
			!(confirmDialogs && path.includes(confirmDialogs))
		) {
			closeMenu();
		}
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.stopPropagation();
			closeMenu();
			return;
		}
		if (mode !== 'menu' || !panel) return;
		const items = Array.from(panel.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
		if (items.length === 0) return;
		const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			items[(currentIndex + 1) % items.length]?.focus();
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			items[(currentIndex - 1 + items.length) % items.length]?.focus();
		}
	}

	$effect(() => {
		if (!open) return;
		void refinePanelPosition();
		// Reading `mode` here (not just above) makes this effect re-run —
		// and re-flip the panel for its new height — when Edit field toggles
		// the panel between the menu list and the (taller) edit form.
		if (mode === 'menu') firstMenuItem?.focus();
		else labelInput?.focus();
	});
</script>

<svelte:window
	onclick={handleWindowClick}
	onscroll={handleWindowScrollOrResize}
	onresize={handleWindowScrollOrResize}
/>

<div class="relative inline-block" bind:this={container}>
	<button
		type="button"
		bind:this={trigger}
		onclick={() => (open ? closeMenu() : openMenu())}
		class="rounded p-1 text-muted transition-colors hover:bg-surface hover:text-fg"
		class:text-accent={visible === false}
		aria-haspopup="menu"
		aria-expanded={open}
		aria-label="Field options for {property.label}"
		title="Field options"
	>
		<Icon name="dots" size={14} />
	</button>

	{#if open}
		<div
			bind:this={panel}
			use:portal
			role={mode === 'menu' ? 'menu' : 'group'}
			aria-label={mode === 'menu'
				? `${property.label} field options`
				: `Edit ${property.label} field`}
			tabindex="-1"
			onkeydown={handleKeydown}
			style={panelStyle}
			class="z-50 max-h-[calc(100vh-16px)] overflow-y-auto rounded-lg border border-border bg-bg p-1 text-left shadow-lg ring-1 ring-black/5"
		>
			{#if mode === 'menu'}
				<button
					type="button"
					role="menuitem"
					bind:this={firstMenuItem}
					onclick={openEdit}
					class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-surface"
				>
					<Icon name="pencil" size={14} />
					<span>Edit field</span>
				</button>
				<button
					type="button"
					role="menuitem"
					onclick={() => insertField('left')}
					class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-surface"
				>
					<Icon name="chevron-left" size={14} />
					<span>Insert left</span>
				</button>
				<button
					type="button"
					role="menuitem"
					onclick={() => insertField('right')}
					class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-surface"
				>
					<Icon name="chevron-right" size={14} />
					<span>Insert right</span>
				</button>
				<button
					type="button"
					role="menuitem"
					onclick={duplicate}
					class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-surface"
				>
					<Icon name="duplicate" size={14} />
					<span>Duplicate</span>
				</button>
				{#if onToggleVisible}
					<button
						type="button"
						role="menuitem"
						onclick={toggleVisible}
						class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-surface"
					>
						<Icon name="eye-off" size={14} />
						<span>{visible === false ? 'Show in this view' : 'Hide in this view'}</span>
					</button>
				{/if}
				<div class="my-1 border-t border-border"></div>
				<button
					type="button"
					role="menuitem"
					onclick={openDeleteConfirm}
					class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
				>
					<Icon name="trash" size={14} />
					<span>Delete field</span>
				</button>
			{:else}
				<form class="space-y-2 p-2" onsubmit={saveEdit}>
					<label class="block text-xs font-medium text-fg">
						Label
						<input
							bind:this={labelInput}
							bind:value={editLabel}
							class="mt-1 w-full rounded border border-border bg-surface px-2 py-1 text-sm text-fg outline-none focus:border-accent"
						/>
					</label>
					<label class="block text-xs font-medium text-fg">
						Type
						<select
							bind:value={editType}
							class="mt-1 w-full rounded border border-border bg-surface px-2 py-1 text-sm text-fg outline-none focus:border-accent"
						>
							{#each PROPERTY_TYPES as t (t)}
								<option value={t}>{t}</option>
							{/each}
						</select>
					</label>
					{#if editType !== property.type && typeChangePreview.affected > 0}
						<p class="text-xs text-amber-600">
							Changing type will clear the value on {typeChangePreview.affected} of {typeChangePreview.total}
							filled record(s).
						</p>
					{/if}
					<div class="flex justify-end gap-2 pt-1">
						<button
							type="button"
							onclick={() => (mode = 'menu')}
							class="rounded px-2 py-1 text-xs text-muted hover:text-fg">Cancel</button
						>
						<button
							type="submit"
							class="rounded bg-accent px-2 py-1 text-xs font-medium text-accent-fg">Save</button
						>
					</div>
				</form>
				{#if property.type === 'select'}
					<div class="border-t border-border p-2">
						<span class="text-xs font-medium text-fg">Options</span>
						<ul class="mt-1.5 space-y-0.5" role="list">
							{#each options as option, index (option.id)}
								<li
									class="flex items-center gap-1 rounded px-0.5 py-0.5"
									class:bg-surface={dragOverOptionId === option.id}
									ondragover={(e) => {
										e.preventDefault();
										dragOverOptionId = option.id;
									}}
									ondragleave={() => {
										if (dragOverOptionId === option.id) dragOverOptionId = null;
									}}
									ondrop={(e) => {
										e.preventDefault();
										handleOptionDrop(option.id);
									}}
								>
									<span
										draggable="true"
										ondragstart={(e) => handleOptionDragStart(e, option.id)}
										ondragend={() => {
											draggedOptionId = null;
											dragOverOptionId = null;
										}}
										class="cursor-grab text-muted"
										aria-hidden="true"
										title="Drag to reorder"
									>
										<Icon name="grip" size={12} />
									</span>
									<div class="flex flex-col">
										<button
											type="button"
											onclick={() => moveOption(index, -1)}
											disabled={index === 0}
											class="text-muted hover:text-fg disabled:opacity-30"
											aria-label="Move {option.label} up"
										>
											<Icon name="arrow-up" size={9} />
										</button>
										<button
											type="button"
											onclick={() => moveOption(index, 1)}
											disabled={index === options.length - 1}
											class="text-muted hover:text-fg disabled:opacity-30"
											aria-label="Move {option.label} down"
										>
											<Icon name="arrow-down" size={9} />
										</button>
									</div>
									<div class="relative">
										<button
											type="button"
											onclick={() => toggleColorPicker(option.id)}
											class="h-4 w-4 flex-shrink-0 rounded-full border border-border"
											style="background-color: {option.color ?? 'transparent'}"
											aria-label="Color for {option.label}"
										></button>
										{#if colorPickerOptionId === option.id}
											<div
												class="absolute top-full left-0 z-10 mt-1 grid grid-cols-3 gap-1 rounded border border-border bg-bg p-1.5 shadow-md"
											>
												{#each SELECT_OPTION_COLORS as swatch (swatch.value)}
													<button
														type="button"
														onclick={() => setOptionColor(option.id, swatch.value)}
														class="h-4 w-4 rounded-full border border-border"
														style="background-color: {swatch.value}"
														aria-label={swatch.label}
														title={swatch.label}
													></button>
												{/each}
											</div>
										{/if}
									</div>
									<input
										type="text"
										value={option.label}
										onblur={(e) => {
											const input = e.target as HTMLInputElement;
											if (!renameOption(option.id, input.value)) input.value = option.label;
										}}
										onkeydown={(e) => {
											if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
										}}
										class="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs text-fg hover:border-border focus:border-accent focus:outline-none"
										aria-label="Rename option {option.label}"
									/>
									<button
										type="button"
										onclick={() => openDeleteOptionConfirm(option.id, option.label)}
										class="rounded p-0.5 text-muted hover:text-red-600"
										aria-label="Delete option {option.label}"
									>
										<Icon name="trash" size={11} />
									</button>
								</li>
							{:else}
								<li class="py-1 text-xs text-muted italic">No options yet.</li>
							{/each}
						</ul>
						<form class="mt-1.5 flex gap-1" onsubmit={submitAddOption}>
							<label class="sr-only" for="field-menu-new-option-{property.key}">Add option</label>
							<input
								id="field-menu-new-option-{property.key}"
								type="text"
								bind:value={newOptionLabel}
								placeholder="Add option…"
								class="min-w-0 flex-1 rounded border border-border bg-surface px-1.5 py-1 text-xs text-fg outline-none placeholder:text-muted focus:border-accent"
							/>
							<button
								type="submit"
								disabled={!newOptionLabel.trim()}
								class="rounded bg-accent px-2 py-1 text-xs font-medium text-accent-fg disabled:opacity-40"
							>
								Add
							</button>
						</form>
						{#if optionError}
							<p class="mt-1 text-xs text-red-600" role="alert">{optionError}</p>
						{/if}
					</div>
				{/if}
			{/if}
			{#if errorMessage}
				<p class="border-t border-border px-2 py-1.5 text-xs text-red-600" role="alert">
					{errorMessage}
				</p>
			{/if}
		</div>
	{/if}
</div>

<div bind:this={confirmDialogs}>
	<ConfirmDialog
		open={confirmDeleteOpen}
		title="Delete field"
		message={`Delete "${property.label}"? ${deleteAffectedCount} record(s) currently have a value for this field. This cannot be undone.`}
		confirmLabel="Delete field"
		onConfirm={confirmDelete}
		onCancel={() => (confirmDeleteOpen = false)}
	/>
	<ConfirmDialog
		open={deleteOptionId !== null}
		title="Delete option"
		message={`Delete "${deleteOptionLabel}"? ${deleteOptionAffectedCount} record(s) currently have this value — they will show as unassigned (Board's "No ${property.label}" column). This cannot be undone.`}
		confirmLabel="Delete option"
		onConfirm={confirmDeleteOption}
		onCancel={() => (deleteOptionId = null)}
	/>
</div>
{#if errorMessage && !open}
	<p class="mt-1 text-xs text-red-600" role="alert">{errorMessage}</p>
{/if}
{#if optionError && !open}
	<p class="mt-1 text-xs text-red-600" role="alert">{optionError}</p>
{/if}
