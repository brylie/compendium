<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { CURRENT_USER } from '$lib/client/actor';
	import { resolveChildPages, setRecordChildPagesConfig } from '$lib/data/records';
	import type {
		ChildPageNode,
		ChildPagesDepth,
		DocumentMeta,
		WorkspaceRecord
	} from '$lib/data/types';
	import type * as Y from 'yjs';
	import Icon from './Icon.svelte';

	let {
		block,
		ydoc,
		documents,
		currentDocumentId
	}: {
		block: WorkspaceRecord;
		ydoc: Y.Doc;
		// Catalog-backed (see doc/[id]/+page.server.ts), not derived from ydoc —
		// a sharded Document's own meta entry doesn't live in this Document's
		// doc at all (#120), only its own shard does. Not live across other
		// clients, same accepted tradeoff as Sidebar's list (see issue #43's
		// scoping comment on the issue itself and data-model.md §3).
		documents: DocumentMeta[];
		currentDocumentId: string;
	} = $props();

	const DEPTH_OPTIONS: { value: ChildPagesDepth; label: string }[] = [
		{ value: 1, label: 'Immediate children' },
		{ value: 2, label: '2 levels' },
		{ value: 3, label: '3 levels' },
		{ value: 'unlimited', label: 'Unlimited' }
	];

	const targetId = $derived(block.referencedRecordId ?? currentDocumentId);
	const targetDoc = $derived(documents.find((d) => d.id === targetId));
	const isBroken = $derived(!!block.referencedRecordId && !targetDoc);
	const depth = $derived(block.childPagesDepth ?? 1);
	const depthLabel = $derived(
		DEPTH_OPTIONS.find((o) => o.value === depth)?.label ?? 'Immediate children'
	);
	const children = $derived(isBroken ? [] : resolveChildPages(documents, targetId, depth));

	let open = $state(false);
	let container: HTMLDivElement | undefined = $state();

	function toggleMenu(): void {
		open = !open;
	}

	function retarget(newTargetId: string): void {
		setRecordChildPagesConfig(
			ydoc,
			block.id,
			{ referencedRecordId: newTargetId || null },
			CURRENT_USER
		);
	}

	function redepth(newDepth: string): void {
		const parsed: ChildPagesDepth = newDepth === 'unlimited' ? 'unlimited' : Number(newDepth);
		setRecordChildPagesConfig(
			ydoc,
			block.id,
			{ depth: parsed === 1 ? null : parsed },
			CURRENT_USER
		);
	}

	function handleWindowClick(event: MouseEvent): void {
		if (!open || !container) return;
		if (!container.contains(event.target as Node)) open = false;
	}

	function handleWindowKeydown(event: KeyboardEvent): void {
		if (open && event.key === 'Escape') {
			event.stopPropagation();
			open = false;
		}
	}
</script>

<svelte:window onclick={handleWindowClick} onkeydown={handleWindowKeydown} />

<div class="my-2 rounded-lg border border-border bg-surface/60 p-4">
	<div class="flex items-center justify-between gap-2">
		<div class="flex items-center gap-2 text-xs font-semibold tracking-wider text-muted uppercase">
			<Icon name="child-pages" size={15} class="text-accent" />
			<span>Child pages</span>
		</div>
		<div class="relative flex-shrink-0" bind:this={container}>
			<button
				type="button"
				onclick={toggleMenu}
				class="rounded p-0.5 text-muted opacity-90 hover:bg-surface hover:text-accent hover:opacity-100"
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label="Child pages settings"
				title="Change target or depth"
			>
				<Icon name="dots" size={15} />
			</button>
			{#if open}
				<div
					role="menu"
					aria-label="Child pages settings"
					tabindex="-1"
					class="absolute top-full right-0 z-20 mt-1 w-56 rounded-lg border border-border bg-bg p-2 text-left text-sm text-fg shadow-lg ring-1 ring-black/5"
				>
					<label
						class="block px-1 pb-1 text-xs font-medium text-muted"
						for="child-pages-target-{block.id}"
					>
						Page
					</label>
					<select
						id="child-pages-target-{block.id}"
						value={block.referencedRecordId ?? ''}
						onchange={(e) => retarget((e.target as HTMLSelectElement).value)}
						class="mb-2 w-full rounded border border-border bg-surface px-1.5 py-1 text-xs text-fg outline-none focus:border-accent"
					>
						<option value="">Current page (default)</option>
						{#each documents.filter((d) => d.id !== currentDocumentId) as d (d.id)}
							<option value={d.id}>{d.title || 'Untitled'}</option>
						{/each}
					</select>
					<label
						class="block px-1 pb-1 text-xs font-medium text-muted"
						for="child-pages-depth-{block.id}"
					>
						Depth
					</label>
					<select
						id="child-pages-depth-{block.id}"
						value={String(depth)}
						onchange={(e) => redepth((e.target as HTMLSelectElement).value)}
						class="w-full rounded border border-border bg-surface px-1.5 py-1 text-xs text-fg outline-none focus:border-accent"
					>
						{#each DEPTH_OPTIONS as o (o.value)}
							<option value={String(o.value)}>{o.label}</option>
						{/each}
					</select>
				</div>
			{/if}
		</div>
	</div>

	{#if isBroken}
		<p class="mt-2 text-xs text-muted italic">
			Target page is unavailable. Choose another page from the settings menu.
		</p>
	{:else}
		<div class="mt-2 space-y-1 text-sm">
			{#snippet renderNode(node: ChildPageNode)}
				<li class="list-none">
					<a
						href={resolve('/space/[spaceId]/doc/[id]', {
							spaceId: page.params.spaceId!,
							id: node.id
						})}
						class="flex items-center gap-1.5 py-0.5 text-fg transition-colors hover:text-accent"
					>
						<Icon name="document" size={13} class="flex-shrink-0 text-muted" />
						<span class="truncate">{node.title || 'Untitled'}</span>
					</a>
					{#if node.children.length > 0}
						<ul class="ml-4 border-l border-border pl-2">
							{#each node.children as child (child.id)}
								{@render renderNode(child)}
							{/each}
						</ul>
					{/if}
				</li>
			{/snippet}
			{#if children.length > 0}
				<ul>
					{#each children as node (node.id)}
						{@render renderNode(node)}
					{/each}
				</ul>
				<p class="mt-1.5 text-[11px] text-muted italic">{depthLabel}</p>
			{:else}
				<p class="text-xs text-muted italic">No sub-pages yet.</p>
			{/if}
		</div>
	{/if}
</div>
