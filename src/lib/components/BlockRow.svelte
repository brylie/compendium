<script module lang="ts">
	import type { TextMarks } from '$lib/data/types';

	// Shared shape of the handle a BlockEditor instance binds onto `blockRefs`
	// — was duplicated (with a narrower, structurally-compatible subset in
	// ColumnsBlock.svelte) at every container that keeps its own `blockRefs`
	// map; both containers now import this one definition (issue #239). Lives
	// in the module script, not the instance script, since a named export
	// (even a type-only one) is only a real export of the compiled module
	// from a `<script module>` block per Svelte 5's own component contract.
	export interface BlockEditorHandle {
		render: () => void;
		applyFormat: (mark: keyof TextMarks, value?: unknown) => void;
		applyFormatAtRange: (
			mark: keyof TextMarks,
			range: { start: number; end: number },
			value?: unknown
		) => void;
		getSelectionRange: () => { start: number; end: number } | null;
		getFormatState: () => Partial<Record<keyof TextMarks, boolean>>;
		focusEditor: (position?: boolean | number) => void;
		focusEditorAtLine: (edge: 'first' | 'last', clientX: number | null) => void;
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import type * as Y from 'yjs';
	import { CURRENT_USER } from '$lib/client/actor';
	import { setRecordChecked } from '$lib/data/record-ops';
	import type { InternalLinkTarget } from '$lib/data/links';
	import type { BlockType, WorkspaceRecord } from '$lib/data/types';
	import BlockEditor from './BlockEditor.svelte';
	import BlockActionMenu from './BlockActionMenu.svelte';
	import Icon from './Icon.svelte';

	// The single shared row unit (issue #239) rendered once per block by both
	// +page.svelte's own top-level flow and ColumnsBlock.svelte's per-column
	// loop: the move handle, the block action menu, multi-select/just-
	// navigated highlighting, the to_do/bullet/numbered/toggle gutter, and the
	// content dispatch for the block types every container supports
	// (divider, quote, and freeform text). A container-specific block type a
	// column's curated child-type subset never produces (callout, code,
	// table_of_contents, synced_block, page_link, collection_view,
	// child_pages, columns — see data-model.md §3.1) is rendered through the
	// `customContent`/`customBlockTypes` extension point instead of living
	// here, since only +page.svelte's top-level flow ever needs it; likewise
	// `trailingContent` (the provenance/sync-usage line) and `insideContent`
	// (the slash-menu popup) are optional extension points a container
	// supplies only when it wants them — ColumnsBlock supplies neither today.
	let {
		block,
		index,
		siblings,
		parentId,
		ydoc,
		ytext,
		linkTargets,
		blockRefs,
		draggingBlockId,
		selectedBlockIds,
		justNavigatedBlockId,
		convertOptions,
		rowClass,
		moveAriaLabel,
		placeholder,
		heldByActorLabel,
		customBlockTypes,
		customContent,
		trailingContent,
		insideContent,
		onDragHandlePointerDown,
		onDragHandleKeydown,
		onDuplicateBlock,
		onDeleteBlock,
		onConvertBlock,
		onCopyBlockLink,
		onMoveBlockUp,
		onMoveBlockDown,
		onFocusBlock,
		onInputText,
		onEnter,
		onBackspaceAtStart,
		onSlashKey,
		onLinkShortcut,
		onArrowUpAtStart,
		onArrowDownAtEnd,
		onToggleCollapse
	}: {
		block: WorkspaceRecord;
		index: number;
		siblings: WorkspaceRecord[];
		parentId: string;
		ydoc: Y.Doc | undefined;
		ytext: Y.Text | undefined;
		linkTargets: Map<string, InternalLinkTarget>;
		blockRefs: Record<string, BlockEditorHandle | undefined>;
		draggingBlockId: string | null;
		selectedBlockIds: Set<string>;
		justNavigatedBlockId: string | null;
		convertOptions: { type: BlockType; label: string }[];
		rowClass: string;
		moveAriaLabel: string;
		placeholder: string;
		heldByActorLabel?: string;
		customBlockTypes?: readonly BlockType[];
		customContent?: Snippet;
		trailingContent?: Snippet;
		insideContent?: Snippet;
		onDragHandlePointerDown: (
			event: PointerEvent,
			blockId: string,
			parentId: string,
			index: number
		) => void;
		onDragHandleKeydown: (event: KeyboardEvent, blockId: string) => void;
		onDuplicateBlock: (blockId: string) => void;
		onDeleteBlock: (blockId: string) => void;
		onConvertBlock: (blockId: string, blockType: BlockType) => void;
		onCopyBlockLink: (blockId: string) => void;
		onMoveBlockUp: (blockId: string) => void;
		onMoveBlockDown: (blockId: string) => void;
		onFocusBlock: () => void;
		onInputText: () => void;
		onEnter: (caretOffset: number) => void;
		onBackspaceAtStart: () => void;
		onSlashKey: () => void;
		onLinkShortcut?: () => void;
		onArrowUpAtStart?: (clientX: number | null) => boolean;
		onArrowDownAtEnd?: (clientX: number | null) => boolean;
		onToggleCollapse?: (block: WorkspaceRecord) => void;
	} = $props();

	let bt = $derived(block.blockType ?? 'paragraph');
	let isConvertible = $derived(convertOptions.some((c) => c.type === bt));

	function headingTextClass(blockType?: BlockType): string {
		switch (blockType) {
			case 'heading_1':
				return 'font-display text-2xl font-bold text-fg';
			case 'heading_2':
				return 'font-display text-xl font-semibold text-fg';
			case 'heading_3':
				return 'font-display text-lg font-semibold text-fg';
			case 'heading_4':
				return 'font-display text-base font-semibold text-fg';
			default:
				return 'text-base text-fg';
		}
	}

	// Consecutive numbered_list_item siblings immediately before this one
	// reset the count — same convention regardless of which container's
	// sibling list is passed in.
	function numberedListIndex(): number {
		let num = 1;
		for (let i = index - 1; i >= 0; i--) {
			if (siblings[i].blockType === 'numbered_list_item') num++;
			else break;
		}
		return num;
	}

	function toggleTodoCheck(): void {
		if (!ydoc) return;
		setRecordChecked(ydoc, block.id, !block.checked, CURRENT_USER);
	}
</script>

<div
	class="group relative {rowClass}"
	class:opacity-50={draggingBlockId === block.id}
	class:bg-surface={selectedBlockIds.has(block.id)}
	class:rounded={selectedBlockIds.has(block.id) || justNavigatedBlockId === block.id}
	class:outline={justNavigatedBlockId === block.id}
	class:outline-2={justNavigatedBlockId === block.id}
	class:outline-accent={justNavigatedBlockId === block.id}
	id="block-{block.id}"
	data-block-row
	data-block-parent={parentId}
>
	<!-- Move handle: pointer-draggable, or ArrowUp/ArrowDown/Home/End once
			 focused; Shift/Ctrl-click or Shift+Arrow selects a range instead
			 (issue #152). -->
	<button
		type="button"
		class="mt-1 mr-1 flex h-5 w-5 flex-shrink-0 cursor-grab items-center justify-center rounded text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-surface hover:text-fg focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent active:cursor-grabbing"
		aria-label={moveAriaLabel}
		data-drag-handle={block.id}
		onpointerdown={(e) => onDragHandlePointerDown(e, block.id, parentId, index)}
		onkeydown={(e) => onDragHandleKeydown(e, block.id)}
	>
		<Icon name="grip" size={14} />
	</button>

	<BlockActionMenu
		blockType={block.blockType}
		canMoveUp={index > 0}
		canMoveDown={index < siblings.length - 1}
		{isConvertible}
		{convertOptions}
		onDuplicate={() => onDuplicateBlock(block.id)}
		onDelete={() => onDeleteBlock(block.id)}
		onConvert={(blockType) => onConvertBlock(block.id, blockType)}
		onCopyLink={() => onCopyBlockLink(block.id)}
		onMoveUp={() => onMoveBlockUp(block.id)}
		onMoveDown={() => onMoveBlockDown(block.id)}
	/>

	<!-- Left Indicator / Control Gutter -->
	{#if bt === 'to_do'}
		<button
			type="button"
			onclick={toggleTodoCheck}
			class="mt-1 mr-2 flex h-4.5 w-4.5 flex-shrink-0 items-center justify-center rounded border border-border bg-bg text-accent transition-colors hover:border-accent"
			class:bg-accent={block.checked}
			class:border-accent={block.checked}
			title={block.checked ? 'Mark as incomplete' : 'Mark as complete'}
			aria-label={block.checked ? 'Mark as incomplete' : 'Mark as complete'}
		>
			{#if block.checked}
				<Icon name="check" size={13} class="stroke-[2.5] text-accent-fg" />
			{/if}
		</button>
	{:else if bt === 'bulleted_list_item'}
		<span
			class="mt-1 mr-2.5 flex h-4 w-3.5 flex-shrink-0 items-center justify-center font-bold text-muted select-none"
		>
			•
		</span>
	{:else if bt === 'numbered_list_item'}
		<span
			class="mt-1 mr-2 flex w-5 flex-shrink-0 items-center justify-end text-xs font-medium text-muted select-none"
		>
			{numberedListIndex()}.
		</span>
	{:else if bt === 'toggle' && onToggleCollapse}
		<button
			type="button"
			onclick={() => onToggleCollapse?.(block)}
			class="mt-1 mr-1 flex h-4.5 w-4.5 flex-shrink-0 items-center justify-center rounded text-muted hover:bg-surface hover:text-fg"
			aria-label={block.collapsed ? 'Expand section' : 'Collapse section'}
		>
			<Icon name={block.collapsed ? 'chevron-right' : 'chevron-down'} size={14} />
		</button>
	{/if}

	<!-- Block Content -->
	<div class="min-w-0 flex-1">
		{#if heldByActorLabel}
			<!-- Held / Placeholder Block (M1 Design System) -->
			<!--
					role="group", not role="status": the persistent live region
					above (only a container that renders one supplies
					heldByActorLabel at all) is the sole announcement source. A
					role="status" here would be a second, independent live
					region — every hold's insertion would announce a second time
					on top of the region's own announcement.
				-->
			<div
				class="flex h-7 items-center gap-2 rounded-md bg-surface/40 px-2 py-1"
				title="{heldByActorLabel} is editing this block"
				role="group"
				aria-label="{heldByActorLabel} is editing this block"
			>
				<span
					class="flex h-4.5 w-4.5 flex-shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-accent-fg"
					aria-hidden="true"
				>
					{heldByActorLabel.slice(0, 1).toUpperCase()}
				</span>
				<div class="shimmer-bar h-3 flex-1 rounded bg-surface" aria-hidden="true"></div>
				<span class="text-[11px] font-medium text-muted" aria-hidden="true"
					>{heldByActorLabel} editing…</span
				>
			</div>
		{:else if bt === 'divider'}
			<div class="my-3 border-t border-border"></div>
		{:else if customContent && customBlockTypes?.includes(bt)}
			{@render customContent()}
		{:else if bt === 'quote'}
			<div class="border-l-2 border-accent/60 py-0.5 pl-3.5 text-fg/90 italic">
				{#if ytext}
					<BlockEditor
						bind:this={blockRefs[block.id]}
						{ytext}
						recordId={block.id}
						{linkTargets}
						placeholder="Quote…"
						{onInputText}
						{onEnter}
						{onBackspaceAtStart}
						{onFocusBlock}
						onSlashKey={() => {}}
						{onLinkShortcut}
						isFirstBlock={index === 0}
						isLastBlock={index === siblings.length - 1}
						{onArrowUpAtStart}
						{onArrowDownAtEnd}
					/>
				{/if}
			</div>
		{:else}
			<div
				class:line-through={bt === 'to_do' && block.checked}
				class:text-muted={bt === 'to_do' && block.checked}
			>
				{#if ytext}
					<BlockEditor
						bind:this={blockRefs[block.id]}
						{ytext}
						recordId={block.id}
						{linkTargets}
						class={headingTextClass(bt)}
						{placeholder}
						{onInputText}
						{onEnter}
						{onBackspaceAtStart}
						{onFocusBlock}
						{onSlashKey}
						{onLinkShortcut}
						isFirstBlock={index === 0}
						isLastBlock={index === siblings.length - 1}
						{onArrowUpAtStart}
						{onArrowDownAtEnd}
					/>
				{/if}
			</div>
		{/if}

		{#if insideContent}
			{@render insideContent()}
		{/if}
	</div>

	{#if trailingContent}
		{@render trailingContent()}
	{/if}
</div>

<style>
	.shimmer-bar {
		background: linear-gradient(
			90deg,
			var(--color-surface) 25%,
			var(--color-border) 50%,
			var(--color-surface) 75%
		);
		background-size: 200% 100%;
		animation: shimmer 1.5s ease-in-out infinite;
	}
	@keyframes shimmer {
		0% {
			background-position: 200% 0;
		}
		100% {
			background-position: -200% 0;
		}
	}
</style>
