<script lang="ts">
	import { tick } from 'svelte';
	import type { BlockType } from '$lib/data/types';
	import Icon from './Icon.svelte';

	// Per-block "…" action menu (issue #152) — duplicate/delete/convert/
	// copy-link/move, the mouse-and-keyboard counterpart to the block's own
	// move handle (issue #40). Modeled directly on FieldMenu.svelte's
	// portalled-dropdown mechanics (Table's per-field "⋯" menu): a `fixed`-
	// position panel computed off the trigger's own rect (so it escapes any
	// `overflow` ancestor the same way FieldMenu's does), Up/Down roving focus
	// among `[role="menuitem"]`, and Escape/outside-click close.
	let {
		blockType,
		canMoveUp,
		canMoveDown,
		isConvertible,
		convertOptions,
		onDuplicate,
		onDelete,
		onConvert,
		onCopyLink,
		onMoveUp,
		onMoveDown
	}: {
		blockType?: BlockType;
		canMoveUp: boolean;
		canMoveDown: boolean;
		isConvertible: boolean;
		convertOptions: { type: BlockType; label: string }[];
		onDuplicate: () => void;
		onDelete: () => void;
		onConvert: (blockType: BlockType) => void;
		onCopyLink: () => void;
		onMoveUp: () => void;
		onMoveDown: () => void;
	} = $props();

	const MENU_WIDTH = 208; // px — matches the panel's w-52

	let open = $state(false);
	let mode = $state<'menu' | 'convert'>('menu');
	let panelStyle = $state('');

	let container: HTMLDivElement | undefined = $state();
	let trigger: HTMLButtonElement | undefined = $state();
	let panel: HTMLDivElement | undefined = $state();
	let firstMenuItem: HTMLButtonElement | undefined = $state();

	// Portalled to <body>, not positioned `absolute` inside `container` — a
	// block row commonly sits inside a scroll container (the Blocks Canvas
	// itself, or a column's own wrapper), and `fixed` positioning computed
	// from the trigger's viewport rect sidesteps any ancestor `overflow`
	// clipping the same way FieldMenu.svelte's own portal does.
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
		const rect = trigger.getBoundingClientRect();
		const left = Math.min(Math.max(8, rect.left), window.innerWidth - MENU_WIDTH - 8);
		panelStyle = `position: fixed; top: ${rect.bottom + 4}px; left: ${left}px; width: ${MENU_WIDTH}px;`;
	}

	async function refinePanelPosition(): Promise<void> {
		await tick();
		if (!trigger || !panel) return;
		const rect = trigger.getBoundingClientRect();
		const panelHeight = panel.getBoundingClientRect().height;
		const left = Math.min(Math.max(8, rect.left), window.innerWidth - MENU_WIDTH - 8);
		const overflowsBelow = rect.bottom + 4 + panelHeight > window.innerHeight - 8;
		const top = overflowsBelow ? Math.max(8, rect.top - panelHeight - 4) : rect.bottom + 4;
		panelStyle = `position: fixed; top: ${top}px; left: ${left}px; width: ${MENU_WIDTH}px;`;
	}

	function handleWindowScrollOrResize(): void {
		if (open) closeMenu(false);
	}

	function openMenu(): void {
		updatePanelPosition();
		open = true;
		mode = 'menu';
	}

	// `restoreFocus` defaults to true (the keyboard-dismissal and item-
	// activation paths, where returning focus to the trigger is exactly what
	// should happen) but must be false for a dismissal the user didn't aim at
	// this menu at all — an outside click or a scroll/resize. Both of those
	// fire *after* the browser has already moved focus wherever the user
	// actually clicked (e.g. into a block's own editor); forcing focus back
	// to the trigger there would silently steal it from where the user just
	// clicked, and the next keystroke would hit this button instead of the
	// editor.
	function closeMenu(restoreFocus = true): void {
		open = false;
		if (restoreFocus) trigger?.focus();
	}

	function run(action: () => void): void {
		action();
		closeMenu();
	}

	function handleWindowClick(event: MouseEvent): void {
		if (!open || !container) return;
		const path = event.composedPath();
		if (!path.includes(container) && !(panel && path.includes(panel))) {
			closeMenu(false);
		}
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.stopPropagation();
			if (mode === 'convert') {
				mode = 'menu';
				void refinePanelPosition().then(() => firstMenuItem?.focus());
			} else {
				closeMenu();
			}
			return;
		}
		if (!panel) return;
		// Disabled menuitems (e.g. "Move up" at the first position) can't
		// receive focus at all — including them here would make
		// ArrowUp/ArrowDown compute a `currentIndex` that never matches
		// `document.activeElement`, silently stalling roving focus right
		// before the disabled item instead of skipping over it.
		const items = Array.from(
			panel.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
		);
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
		firstMenuItem?.focus();
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
		class="mt-1 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-surface hover:text-fg focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
		aria-haspopup="menu"
		aria-expanded={open}
		aria-label="Block actions"
		title="Block actions"
	>
		<Icon name="dots" size={14} />
	</button>

	{#if open}
		<div
			bind:this={panel}
			use:portal
			role={mode === 'menu' ? 'menu' : 'group'}
			aria-label={mode === 'menu' ? 'Block actions' : 'Convert block to'}
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
					onclick={() => run(onDuplicate)}
					class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-surface"
				>
					<Icon name="duplicate" size={14} />
					<span>Duplicate</span>
				</button>
				{#if isConvertible}
					<button
						type="button"
						role="menuitem"
						onclick={() => {
							mode = 'convert';
							void refinePanelPosition().then(() => firstMenuItem?.focus());
						}}
						class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-surface"
					>
						<Icon name="convert" size={14} />
						<span>Convert to…</span>
					</button>
				{/if}
				<button
					type="button"
					role="menuitem"
					onclick={() => run(onCopyLink)}
					class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-surface"
				>
					<Icon name="link" size={14} />
					<span>Copy link to block</span>
				</button>
				<button
					type="button"
					role="menuitem"
					onclick={() => run(onMoveUp)}
					disabled={!canMoveUp}
					class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
				>
					<Icon name="arrow-up" size={14} />
					<span>Move up</span>
				</button>
				<button
					type="button"
					role="menuitem"
					onclick={() => run(onMoveDown)}
					disabled={!canMoveDown}
					class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
				>
					<Icon name="arrow-down" size={14} />
					<span>Move down</span>
				</button>
				<div class="my-1 border-t border-border"></div>
				<button
					type="button"
					role="menuitem"
					onclick={() => run(onDelete)}
					class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
				>
					<Icon name="trash" size={14} />
					<span>Delete</span>
				</button>
			{:else}
				<button
					type="button"
					role="menuitem"
					bind:this={firstMenuItem}
					onclick={() => {
						mode = 'menu';
						void refinePanelPosition().then(() => firstMenuItem?.focus());
					}}
					class="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted hover:bg-surface"
				>
					<Icon name="chevron-left" size={14} />
					<span>Back</span>
				</button>
				{#each convertOptions as option (option.type)}
					<button
						type="button"
						role="menuitem"
						disabled={option.type === blockType}
						onclick={() => run(() => onConvert(option.type))}
						class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
					>
						<span>{option.label}</span>
						{#if option.type === blockType}
							<Icon name="check" size={13} class="ml-auto text-accent" />
						{/if}
					</button>
				{/each}
			{/if}
		</div>
	{/if}
</div>
