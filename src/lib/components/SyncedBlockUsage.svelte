<script lang="ts">
	import { tick } from 'svelte';
	import { resolve } from '$app/paths';
	import type { Backlink } from '$lib/data/links';
	import Icon from './Icon.svelte';

	// "Used in N places" + detach affordance for issue #153's synced-block
	// provenance UX — shown on a sync source (every `instances` entry is one
	// synced_block instance elsewhere) and on a synced_block instance itself
	// (`instances` there is every *other* instance, plus an onDetach action).
	// Positioning/outside-click/Escape mechanics mirror BlockActionMenu.svelte's
	// portalled dropdown; kept simpler here since this menu is just a list of
	// links plus at most one action, not a multi-mode menu.
	let {
		spaceId,
		currentDocumentId,
		instances,
		onJumpTo,
		onDetach
	}: {
		spaceId: string;
		currentDocumentId: string;
		instances: Backlink[];
		onJumpTo: (documentId: string, recordId: string) => void;
		onDetach?: () => void;
	} = $props();

	const PANEL_WIDTH = 260;

	let open = $state(false);
	let panelStyle = $state('');
	let container: HTMLDivElement | undefined = $state();
	let trigger: HTMLButtonElement | undefined = $state();
	let panel: HTMLDivElement | undefined = $state();

	function portal(node: HTMLElement): { destroy(): void } {
		document.body.appendChild(node);
		return {
			destroy() {
				node.remove();
			}
		};
	}

	async function refinePanelPosition(): Promise<void> {
		await tick();
		if (!trigger || !panel) return;
		const rect = trigger.getBoundingClientRect();
		const panelHeight = panel.getBoundingClientRect().height;
		const left = Math.min(Math.max(8, rect.left), window.innerWidth - PANEL_WIDTH - 8);
		const overflowsBelow = rect.bottom + 4 + panelHeight > window.innerHeight - 8;
		const top = overflowsBelow ? Math.max(8, rect.top - panelHeight - 4) : rect.bottom + 4;
		panelStyle = `position: fixed; top: ${top}px; left: ${left}px; width: ${PANEL_WIDTH}px;`;
	}

	function closeMenu(restoreFocus = true): void {
		open = false;
		if (restoreFocus) trigger?.focus();
	}

	function toggleMenu(): void {
		if (open) {
			closeMenu();
			return;
		}
		open = true;
		void refinePanelPosition();
	}

	function handleWindowClick(event: MouseEvent): void {
		if (!open || !container) return;
		const path = event.composedPath();
		if (!path.includes(container) && !(panel && path.includes(panel))) closeMenu(false);
	}

	function handleWindowScrollOrResize(): void {
		if (open) closeMenu(false);
	}

	// Roving focus between menuitems (the `<a>` locations plus the trailing
	// Detach `<button>`, when present) — same pattern as BlockActionMenu.svelte's
	// own handleKeydown, needed here for the same reason: the panel is portalled
	// to `document.body`, so Tab doesn't reach it and arrow keys are the only
	// way to move between its items without a mouse.
	function handleKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.stopPropagation();
			closeMenu();
			return;
		}
		if (!panel) return;
		const items = Array.from(panel.querySelectorAll<HTMLElement>('[role="menuitem"]'));
		if (items.length === 0) return;
		const currentIndex = items.indexOf(document.activeElement as HTMLElement);
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			items[(currentIndex + 1) % items.length]?.focus();
		} else if (event.key === 'ArrowUp') {
			event.preventDefault();
			items[(currentIndex - 1 + items.length) % items.length]?.focus();
		}
	}

	function jumpTo(instance: Backlink): void {
		onJumpTo(instance.sourceDocumentId, instance.sourceRecordId);
		closeMenu(false);
	}

	function detach(): void {
		onDetach?.();
		closeMenu(false);
	}

	async function focusFirstMenuItem(): Promise<void> {
		await tick();
		panel?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
	}

	$effect(() => {
		if (!open) return;
		void refinePanelPosition();
		void focusFirstMenuItem();
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
		onclick={toggleMenu}
		class="flex items-center gap-1 rounded px-1 text-[11px] text-muted transition-colors hover:bg-surface hover:text-accent"
		aria-haspopup="menu"
		aria-expanded={open}
	>
		<span>Used in {instances.length} {instances.length === 1 ? 'place' : 'places'}</span>
		<Icon name="chevron-down" size={11} />
	</button>

	{#if open}
		<div
			bind:this={panel}
			use:portal
			role="menu"
			aria-label="Synced block usage"
			tabindex="-1"
			onkeydown={handleKeydown}
			style={panelStyle}
			class="z-50 max-h-[calc(100vh-16px)] overflow-y-auto rounded-lg border border-border bg-bg p-1 text-left shadow-lg ring-1 ring-black/5"
		>
			{#if instances.length > 0}
				<div class="px-2 pt-1 pb-0.5 text-[11px] font-medium tracking-wide text-muted uppercase">
					Used in {instances.length}
					{instances.length === 1 ? 'place' : 'places'}
				</div>
				{#each instances as instance (instance.sourceRecordId)}
					<a
						role="menuitem"
						href="{resolve('/space/[spaceId]/doc/[id]', {
							spaceId,
							id: instance.sourceDocumentId
						})}#block-{instance.sourceRecordId}"
						onclick={(e) => {
							if (instance.sourceDocumentId === currentDocumentId) {
								e.preventDefault();
								jumpTo(instance);
							} else {
								closeMenu(false);
							}
						}}
						class="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-surface"
					>
						<span class="truncate font-medium"
							>{instance.sourceDocumentTitle || 'Untitled Document'}</span
						>
						<span class="truncate text-xs text-muted">{instance.context}</span>
					</a>
				{/each}
			{:else}
				<p class="px-2 py-1.5 text-xs text-muted italic">No other locations yet.</p>
			{/if}
			{#if onDetach}
				<div class="my-1 border-t border-border"></div>
				<button
					type="button"
					role="menuitem"
					onclick={detach}
					class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg hover:bg-surface"
				>
					<Icon name="unlink" size={14} />
					<span>Detach to independent copy</span>
				</button>
			{/if}
		</div>
	{/if}
</div>
