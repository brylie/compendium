<script lang="ts">
	import { ChevronsRight, Redo2, Undo2 } from '@lucide/svelte';
	import type { TextMarks } from '$lib/data/types';
	import {
		TOOLBAR_CONTROLS,
		computeVisibleInsertCount,
		type ToolbarControl
	} from './toolbar-controls';

	let {
		controls = TOOLBAR_CONTROLS,
		activeMarks = {},
		hasActiveEditor = false,
		canUndo = false,
		canRedo = false,
		insertGroupWidthOverride,
		onFormat,
		onInsert,
		onUndo = () => {},
		onRedo = () => {}
	}: {
		controls?: readonly ToolbarControl[];
		activeMarks?: Partial<Record<keyof TextMarks, boolean>>;
		hasActiveEditor?: boolean;
		canUndo?: boolean;
		canRedo?: boolean;
		// Test-only: forces the width computeVisibleInsertCount() sees,
		// bypassing bind:clientWidth below entirely. Real usage never passes
		// this — measuredInsertGroupWidth (real DOM measurement) drives it.
		// Kept as a distinct one-way prop rather than making the measured
		// value itself bindable: jsdom has no layout engine, so clientWidth
		// always reads 0 there, and bind:clientWidth's own effect would race
		// with — and could clobber — a directly-forced value.
		insertGroupWidthOverride?: number;
		onFormat: (mark: keyof TextMarks) => void;
		onInsert: (blockType: Extract<ToolbarControl, { group: 'insert' }>['blockType']) => void;
		onUndo?: () => void;
		onRedo?: () => void;
	} = $props();

	const formatControls = $derived(controls.filter((control) => control.group === 'format'));
	const insertControls = $derived(controls.filter((control) => control.group === 'insert'));

	// One button treatment shared by every control in both groups — pressed
	// state (format only) layers on top via `class:` bindings below, but
	// size, shape, color, and hover/disabled behavior must never diverge
	// between the two groups: from the outside this reads as one toolbar,
	// not two toolbars glued together at a divider. No disabled:cursor —
	// the dimmed opacity already reads as "unavailable"; a not-allowed
	// cursor on top of it was redundant and visually collided with the
	// hover tooltip right where the pointer sits.
	const CONTROL_CLASS =
		'grid size-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-surface hover:text-fg disabled:opacity-40';

	let measuredInsertGroupWidth = $state(0);
	const insertGroupWidth = $derived(insertGroupWidthOverride ?? measuredInsertGroupWidth);
	const visibleInsertCount = $derived(
		computeVisibleInsertCount(insertControls.length, insertGroupWidth)
	);
	const visibleInsertControls = $derived(insertControls.slice(0, visibleInsertCount));
	const overflowInsertControls = $derived(insertControls.slice(visibleInsertCount));

	let overflowOpen = $state(false);
	let overflowEl: HTMLElement | undefined = $state();

	function selectOverflowControl(control: Extract<ToolbarControl, { group: 'insert' }>): void {
		onInsert(control.blockType);
		overflowOpen = false;
	}

	function handleWindowClick(event: MouseEvent): void {
		if (overflowOpen && !overflowEl?.contains(event.target as Node)) overflowOpen = false;
	}

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (overflowOpen && event.key === 'Escape') overflowOpen = false;
	}
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleWindowKeydown} />

<div
	class="sticky top-0 z-20 flex w-full flex-nowrap items-center gap-1 border-b border-border bg-bg/95 px-4 py-2 backdrop-blur"
	role="toolbar"
	aria-label="Document toolbar"
>
	<div role="group" class="flex shrink-0 items-center gap-1" aria-label="History">
		<span class="group relative">
			<button
				type="button"
				aria-label="Undo"
				disabled={!canUndo}
				onmousedown={(event) => event.preventDefault()}
				onclick={onUndo}
				class={CONTROL_CLASS}
			>
				<Undo2 size={16} strokeWidth={2} aria-hidden="true" />
			</button>
			<span class="toolbar-tooltip" role="tooltip" aria-hidden="true">Undo (⌘/Ctrl+Z)</span>
		</span>
		<span class="group relative">
			<button
				type="button"
				aria-label="Redo"
				disabled={!canRedo}
				onmousedown={(event) => event.preventDefault()}
				onclick={onRedo}
				class={CONTROL_CLASS}
			>
				<Redo2 size={16} strokeWidth={2} aria-hidden="true" />
			</button>
			<span class="toolbar-tooltip" role="tooltip" aria-hidden="true">Redo (⌘/Ctrl+⇧Z, Ctrl+Y)</span
			>
		</span>
	</div>

	<div class="h-5 shrink-0 border-l border-border" aria-hidden="true"></div>

	<div role="group" class="flex shrink-0 items-center gap-1" aria-label="Text formatting">
		{#each formatControls as control (control.id)}
			{@const Icon = control.icon}
			<span class="group relative">
				<button
					type="button"
					aria-label={control.label}
					aria-pressed={activeMarks[control.mark] === true}
					disabled={!hasActiveEditor}
					onmousedown={(event) => event.preventDefault()}
					onclick={() => onFormat(control.mark)}
					class={CONTROL_CLASS}
					class:bg-accent={activeMarks[control.mark] === true}
					class:text-accent-fg={activeMarks[control.mark] === true}
				>
					<Icon size={16} strokeWidth={2} aria-hidden="true" />
				</button>
				<span class="toolbar-tooltip" role="tooltip" aria-hidden="true">{control.label}</span>
			</span>
		{/each}
	</div>

	<div class="h-5 shrink-0 border-l border-border" aria-hidden="true"></div>

	<div
		role="group"
		class="flex min-w-0 flex-1 items-center gap-1"
		aria-label="Insert block"
		bind:clientWidth={measuredInsertGroupWidth}
	>
		{#each visibleInsertControls as control (control.id)}
			{@const Icon = control.icon}
			<span class="group relative shrink-0">
				<button
					type="button"
					aria-label={`Insert ${control.label}`}
					onclick={() => onInsert(control.blockType)}
					class={CONTROL_CLASS}
				>
					<Icon size={16} strokeWidth={2} aria-hidden="true" />
				</button>
				<span class="toolbar-tooltip" role="tooltip" aria-hidden="true">{control.label}</span>
			</span>
		{/each}
	</div>

	{#if overflowInsertControls.length > 0}
		<span class="group relative shrink-0" bind:this={overflowEl}>
			<button
				type="button"
				aria-label="More blocks"
				aria-haspopup="listbox"
				aria-expanded={overflowOpen}
				onclick={() => (overflowOpen = !overflowOpen)}
				class={CONTROL_CLASS}
				class:bg-surface={overflowOpen}
				class:text-fg={overflowOpen}
			>
				<ChevronsRight size={16} strokeWidth={2} aria-hidden="true" />
			</button>
			<span class="toolbar-tooltip" role="tooltip" aria-hidden="true">More blocks</span>

			{#if overflowOpen}
				<div
					role="listbox"
					aria-label="More blocks"
					class="absolute top-full right-0 z-30 mt-1.5 max-h-80 w-52 overflow-y-auto rounded-lg border border-border bg-bg p-1 shadow-lg ring-1 ring-black/5"
				>
					{#each overflowInsertControls as control (control.id)}
						{@const Icon = control.icon}
						<button
							type="button"
							role="option"
							aria-selected="false"
							onclick={() => selectOverflowControl(control)}
							class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm text-fg transition-colors hover:bg-surface hover:text-accent"
						>
							<Icon size={16} strokeWidth={2} class="shrink-0 text-muted" aria-hidden="true" />
							<span class="truncate">{control.label}</span>
						</button>
					{/each}
				</div>
			{/if}
		</span>
	{/if}
</div>

<style>
	/* Custom tooltip rather than the native `title` attribute: `title`'s
	   ~800ms browser-default delay and unstyled appearance read as broken
	   affordance discovery on an icon-only toolbar with 23 controls.
	   `aria-hidden` because the accessible name already comes from
	   `aria-label` on the button — this span is a sighted-user affordance
	   only, not a second announcement. */
	.toolbar-tooltip {
		position: absolute;
		top: 100%;
		left: 50%;
		z-index: 30;
		margin-top: 0.375rem;
		transform: translateX(-50%);
		white-space: nowrap;
		border-radius: 0.25rem;
		background: var(--color-fg);
		color: var(--color-bg);
		font-size: 0.6875rem;
		font-weight: 500;
		padding: 0.125rem 0.375rem;
		opacity: 0;
		pointer-events: none;
		transition:
			opacity 0.1s ease-out 0.3s,
			visibility 0.1s ease-out 0.3s;
		visibility: hidden;
	}

	.group:hover .toolbar-tooltip,
	.group:focus-within .toolbar-tooltip {
		opacity: 1;
		visibility: visible;
	}

	@media (prefers-reduced-motion: reduce) {
		.toolbar-tooltip {
			transition-duration: 0.01ms;
		}
	}
</style>
