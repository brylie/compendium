<script lang="ts">
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { SpaceMeta } from '$lib/data/types';
	import Icon from './Icon.svelte';
	import PromptDialog from './PromptDialog.svelte';

	let {
		spaces,
		activeSpaceId,
		collapsed = false
	}: {
		spaces: SpaceMeta[];
		activeSpaceId: string;
		collapsed?: boolean;
	} = $props();

	const MENU_WIDTH = 224; // px — matches FieldMenu's own menu-mode panel width

	let open = $state(false);
	let creating = $state(false);
	let errorMessage = $state('');
	let panelStyle = $state('');

	let container: HTMLDivElement | undefined = $state();
	let trigger: HTMLButtonElement | undefined = $state();
	let panel: HTMLDivElement | undefined = $state();

	const activeSpace = $derived(spaces.find((s) => s.id === activeSpaceId));

	// Portalled to <body> rather than positioned `absolute` inside `container`
	// — same reasoning as FieldMenu.svelte: `fixed` positioning computed from
	// the trigger's own viewport rect avoids depending on nothing between here
	// and <body> ever clipping overflow.
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

	function openMenu(): void {
		updatePanelPosition();
		open = true;
		errorMessage = '';
	}

	function closeMenu(): void {
		open = false;
		trigger?.focus();
	}

	async function switchTo(spaceId: string): Promise<void> {
		closeMenu();
		if (spaceId === activeSpaceId) return;
		await goto(resolve('/space/[spaceId]', { spaceId }));
	}

	function openCreate(): void {
		closeMenu();
		errorMessage = '';
		creating = true;
	}

	async function createSpace(rawName: string): Promise<void> {
		const name = rawName.trim() || 'Untitled Space';
		// The dialog stays open (and its own errorMessage prop shows the
		// failure inline) until the request actually succeeds — closing it
		// optimistically first would make a failure's error message land in
		// the dropdown panel, which is already closed by then and never
		// rendered (#140 CodeRabbit finding).
		try {
			const res = await fetch('/api/spaces', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name })
			});
			if (res.ok) {
				const space = await res.json();
				creating = false;
				errorMessage = '';
				await goto(resolve('/space/[spaceId]', { spaceId: space.id }));
			} else {
				errorMessage = 'Failed to create space.';
			}
		} catch {
			errorMessage = 'Failed to create space. Check your connection and try again.';
		}
	}

	// See FieldMenu.svelte's identical handler for why composedPath() is used
	// instead of container.contains(event.target).
	function handleWindowClick(event: MouseEvent): void {
		if (!open || !container) return;
		const path = event.composedPath();
		if (!path.includes(container) && !(panel && path.includes(panel))) {
			closeMenu();
		}
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.stopPropagation();
			closeMenu();
			return;
		}
		if (!panel) return;
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
		panel?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
	});
</script>

<svelte:window onclick={handleWindowClick} />

<div class="relative" bind:this={container}>
	{#if collapsed}
		<button
			type="button"
			bind:this={trigger}
			onclick={() => (open ? closeMenu() : openMenu())}
			class="rounded p-2 text-muted transition-colors hover:bg-surface hover:text-accent"
			aria-haspopup="menu"
			aria-expanded={open}
			aria-label="Switch space"
			title={activeSpace?.name ?? 'Switch space'}
		>
			<Icon name="logo" size={18} />
		</button>
	{:else}
		<button
			type="button"
			bind:this={trigger}
			onclick={() => (open ? closeMenu() : openMenu())}
			class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg transition-colors hover:bg-surface"
			aria-haspopup="menu"
			aria-expanded={open}
			aria-label="Switch space"
		>
			<Icon name="logo" size={15} class="flex-shrink-0 text-accent" />
			<span class="flex-1 truncate text-left font-medium">{activeSpace?.name ?? 'Space'}</span>
			<Icon name="chevron-down" size={13} class="flex-shrink-0 text-muted" />
		</button>
	{/if}

	{#if open}
		<div
			bind:this={panel}
			use:portal
			role="menu"
			aria-label="Spaces"
			tabindex="-1"
			onkeydown={handleKeydown}
			style={panelStyle}
			class="z-50 max-h-[calc(100vh-16px)] overflow-y-auto rounded-lg border border-border bg-bg p-1 text-left shadow-lg ring-1 ring-black/5"
		>
			{#each spaces as space (space.id)}
				<button
					type="button"
					role="menuitem"
					onclick={() => void switchTo(space.id)}
					class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-surface"
					class:text-accent={space.id === activeSpaceId}
					class:font-semibold={space.id === activeSpaceId}
				>
					<Icon name="logo" size={14} class="flex-shrink-0 text-accent" />
					<span class="flex-1 truncate">{space.name}</span>
					{#if space.id === activeSpaceId}
						<Icon name="check" size={13} class="flex-shrink-0" />
					{/if}
				</button>
			{/each}
			<div class="my-1 border-t border-border"></div>
			<button
				type="button"
				role="menuitem"
				onclick={openCreate}
				class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-surface"
			>
				<Icon name="plus" size={14} />
				<span>New space</span>
			</button>
		</div>
	{/if}
</div>

<PromptDialog
	open={creating}
	title="New space"
	label="Space name"
	placeholder="Untitled Space"
	submitLabel="Create"
	{errorMessage}
	onSubmit={(value) => void createSpace(value)}
	onCancel={() => {
		creating = false;
		errorMessage = '';
	}}
/>
