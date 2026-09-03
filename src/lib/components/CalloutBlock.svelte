<script lang="ts">
	import type { Snippet } from 'svelte';
	import type * as Y from 'yjs';
	import { CURRENT_USER } from '$lib/client/actor';
	import { setRecordCalloutStyle } from '$lib/data/records';
	import {
		CALLOUT_ICONS,
		CALLOUT_PRESETS,
		CALLOUT_PRESET_CLASSES,
		DEFAULT_CUSTOM_CALLOUT_COLOR,
		deriveCustomCalloutColors
	} from '$lib/data/callout-style';
	import type { CalloutIcon, WorkspaceRecord } from '$lib/data/types';
	import Icon from './Icon.svelte';

	let {
		block,
		ydoc,
		children
	}: {
		block: WorkspaceRecord;
		ydoc: Y.Doc;
		children: Snippet;
	} = $props();

	const style = $derived(block.calloutStyle);
	const presetMeta = $derived(
		style?.kind === 'preset' ? CALLOUT_PRESETS.find((p) => p.value === style.preset) : undefined
	);

	// Pre-#42 records (and any record whose style was never set/was cleared)
	// keep the original neutral appearance — no migration, same precedent
	// primaryFieldKey/viewConfig already established for an unset field.
	const icon: CalloutIcon = $derived(
		style?.kind === 'custom' ? style.icon : (presetMeta?.icon ?? 'callout')
	);
	const wrapperClass = $derived.by(() => {
		if (style?.kind === 'preset') return CALLOUT_PRESET_CLASSES[style.preset];
		if (style?.kind === 'custom') return 'callout-custom';
		return 'bg-surface text-fg';
	});
	const customColors = $derived(
		style?.kind === 'custom' ? deriveCustomCalloutColors(style.color) : undefined
	);
	const wrapperStyle = $derived(
		customColors
			? `--callout-custom-bg-light: ${customColors.bgLight}; --callout-custom-fg-light: ${customColors.fgLight}; --callout-custom-bg-dark: ${customColors.bgDark}; --callout-custom-fg-dark: ${customColors.fgDark};`
			: undefined
	);

	let open = $state(false);
	let customIcon: CalloutIcon = $state('callout');
	let customColor = $state(DEFAULT_CUSTOM_CALLOUT_COLOR);
	let container: HTMLDivElement | undefined = $state();

	function openMenu(): void {
		// Seed the custom-color form from the block's current custom choice
		// (if any) so reopening the menu doesn't reset it to the default.
		if (style?.kind === 'custom') {
			customIcon = style.icon;
			customColor = style.color;
		}
		open = true;
	}

	function choosePreset(preset: (typeof CALLOUT_PRESETS)[number]['value']): void {
		setRecordCalloutStyle(ydoc, block.id, { kind: 'preset', preset }, CURRENT_USER);
		open = false;
	}

	function applyCustom(): void {
		setRecordCalloutStyle(
			ydoc,
			block.id,
			{ kind: 'custom', icon: customIcon, color: customColor },
			CURRENT_USER
		);
		open = false;
	}

	function resetToDefault(): void {
		setRecordCalloutStyle(ydoc, block.id, null, CURRENT_USER);
		open = false;
	}

	function handleWindowClick(event: MouseEvent): void {
		if (!open || !container) return;
		if (!container.contains(event.target as Node)) open = false;
	}

	function handleWindowKeydown(event: KeyboardEvent): void {
		// Attached to the window (not the menu) because focus stays on the
		// trigger button after openMenu() — it's never moved into the menu —
		// so a menu-scoped keydown handler would never see Escape at all.
		if (open && event.key === 'Escape') {
			event.stopPropagation();
			open = false;
		}
	}

	function toggleMenu(): void {
		if (open) {
			open = false;
		} else {
			openMenu();
		}
	}
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleWindowKeydown} />

<div
	class="flex gap-3 rounded-lg border border-border p-3.5 shadow-xs {wrapperClass}"
	style={wrapperStyle}
>
	<div class="relative flex-shrink-0" bind:this={container}>
		<button
			type="button"
			onclick={toggleMenu}
			class="mt-0.5 rounded p-0.5 opacity-90 hover:opacity-100"
			aria-haspopup="menu"
			aria-expanded={open}
			aria-label="Callout style for {presetMeta?.label ?? 'this callout'}"
			title="Change callout style"
		>
			<Icon name={icon} size={18} />
		</button>
		{#if open}
			<div
				role="menu"
				aria-label="Callout style"
				tabindex="-1"
				class="absolute top-full left-0 z-20 mt-1 w-56 rounded-lg border border-border bg-bg p-2 text-left text-sm text-fg shadow-lg ring-1 ring-black/5"
			>
				<p class="px-1 pb-1 text-xs font-medium text-muted">Style</p>
				<ul class="space-y-0.5" role="list">
					{#each CALLOUT_PRESETS as p (p.value)}
						<li>
							<button
								type="button"
								role="menuitem"
								onclick={() => choosePreset(p.value)}
								class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface {CALLOUT_PRESET_CLASSES[
									p.value
								]}"
							>
								<Icon name={p.icon} size={14} />
								<span>{p.label}</span>
							</button>
						</li>
					{/each}
				</ul>
				<div class="mt-2 border-t border-border pt-2">
					<p class="px-1 pb-1 text-xs font-medium text-muted">Custom</p>
					<div class="flex items-center gap-1.5 px-1">
						<label class="sr-only" for="callout-custom-icon-{block.id}">Icon</label>
						<select
							id="callout-custom-icon-{block.id}"
							bind:value={customIcon}
							class="min-w-0 flex-1 rounded border border-border bg-surface px-1.5 py-1 text-xs text-fg outline-none focus:border-accent"
						>
							{#each CALLOUT_ICONS as ic (ic.value)}
								<option value={ic.value}>{ic.label}</option>
							{/each}
						</select>
						<label class="sr-only" for="callout-custom-color-{block.id}">Color</label>
						<input
							id="callout-custom-color-{block.id}"
							type="color"
							bind:value={customColor}
							class="h-7 w-9 flex-shrink-0 cursor-pointer rounded border border-border bg-surface p-0.5"
						/>
						<button
							type="button"
							onclick={applyCustom}
							class="flex-shrink-0 rounded-md bg-accent px-2 py-1 text-xs font-medium text-accent-fg hover:opacity-90"
						>
							Apply
						</button>
					</div>
				</div>
				{#if style}
					<div class="mt-2 border-t border-border pt-2">
						<button
							type="button"
							role="menuitem"
							onclick={resetToDefault}
							class="w-full rounded-md px-2 py-1.5 text-left text-xs text-muted hover:bg-surface hover:text-fg"
						>
							Reset to default
						</button>
					</div>
				{/if}
			</div>
		{/if}
	</div>
	<div class="min-w-0 flex-1">
		{@render children()}
	</div>
</div>
