<script lang="ts">
	import { tick } from 'svelte';
	import type * as Y from 'yjs';
	import { CURRENT_USER } from '$lib/client/actor';
	import {
		createRecord,
		deleteRecord,
		getRecordYText,
		listRecordsForParent,
		MAX_COLUMN_COUNT,
		MIN_COLUMN_COUNT,
		setBlockType
	} from '$lib/data/record-ops';
	import { plainText, yTextToRichText } from '$lib/data/richtext';
	import type { InternalLinkTarget } from '$lib/data/links';
	import type { BlockType, WorkspaceRecord } from '$lib/data/types';
	import BlockRow, { type BlockEditorHandle } from './BlockRow.svelte';
	import Icon from './Icon.svelte';

	let {
		block,
		ydoc,
		linkTargets,
		blockRefs,
		draggingBlockId,
		dropIndicatorParentId,
		dropIndicatorIndex,
		selectedBlockIds,
		justNavigatedBlockId,
		convertOptions,
		onFocusBlock,
		onInputText,
		onDragHandlePointerDown,
		onDragHandleKeydown,
		onDuplicateBlock,
		onDeleteBlock,
		onConvertBlock,
		onCopyBlockLink,
		onMoveBlockUp,
		onMoveBlockDown
	}: {
		block: WorkspaceRecord;
		ydoc: Y.Doc;
		linkTargets: Map<string, InternalLinkTarget>;
		blockRefs: Record<string, BlockEditorHandle | undefined>;
		draggingBlockId: string | null;
		dropIndicatorParentId: string | null;
		dropIndicatorIndex: number | null;
		selectedBlockIds: Set<string>;
		justNavigatedBlockId: string | null;
		convertOptions: { type: BlockType; label: string }[];
		onFocusBlock: (blockId: string) => void;
		onInputText: (blockId: string) => void;
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
	} = $props();

	// A column is a deliberately curated subset of Document block types
	// (issue #148) — no reference/structural/container types, matching
	// columnChildBlockTypes in $lib/data/types.ts and services/records.ts's
	// own creation-time validation. Enter on a list item continues the list,
	// same convention as the top-level editor.
	const LIST_BLOCK_TYPES: readonly BlockType[] = [
		'bulleted_list_item',
		'numbered_list_item',
		'to_do'
	];

	// No separate Yjs subscription of our own here — +page.svelte's own
	// top-level recordsMap.observeDeep already fires on *any* record
	// mutation anywhere in the Document (deep, not scoped to top-level
	// blocks), which rebuilds its `blocks` array and hands this component a
	// fresh `block` prop on every relevant change. Reading straight from
	// `ydoc` in a $derived, keyed off that same prop churn, is exactly the
	// pattern CollectionViewBlock.svelte/ChildPagesBlock.svelte already use
	// for the same reason — an independent observeDeep here would be
	// redundant (and, since it would depend on `block`/`ydoc` transitively
	// through a called function inside an $effect, prone to exactly the
	// re-subscribe-on-every-prop-churn cycle that pattern is for avoiding).
	let columns = $derived(listRecordsForParent(ydoc, block.id));
	let columnBlocks = $derived.by(() => {
		const next: Record<string, WorkspaceRecord[]> = {};
		for (const column of columns) {
			next[column.id] = listRecordsForParent(ydoc, column.id);
		}
		return next;
	});

	function isBlockTextEmpty(id: string): boolean {
		const ytext = getRecordYText(ydoc, id);
		return !ytext || plainText(yTextToRichText(ytext)).length === 0;
	}

	async function addColumnBlockAfter(
		columnId: string,
		afterId?: string,
		blockType: BlockType = 'paragraph'
	): Promise<void> {
		const record = createRecord(
			ydoc,
			{ parentId: columnId, afterRecordId: afterId, blockType },
			CURRENT_USER
		);
		await tick();
		blockRefs[record.id]?.focusEditor(true);
	}

	async function handleEnter(columnId: string, columnRecord: WorkspaceRecord): Promise<void> {
		const blockType = columnRecord.blockType ?? 'paragraph';
		const isList = LIST_BLOCK_TYPES.includes(blockType);
		if (isList && isBlockTextEmpty(columnRecord.id)) {
			setBlockType(ydoc, columnRecord.id, 'paragraph', CURRENT_USER);
			await tick();
			blockRefs[columnRecord.id]?.focusEditor(true);
			return;
		}
		await addColumnBlockAfter(columnId, columnRecord.id, isList ? blockType : 'paragraph');
	}

	async function handleBackspace(columnId: string, index: number): Promise<void> {
		const siblings = columnBlocks[columnId] ?? [];
		const current = siblings[index];
		const previous = siblings[index - 1];
		if (!current) return;
		// The first block in a column has nothing to merge into — leave it
		// alone rather than deleting a column's last remaining content
		// implicitly (removing a column entirely is the "-" control below).
		if (!previous) return;

		if (isBlockTextEmpty(current.id)) {
			deleteRecord(ydoc, current.id);
			await tick();
			blockRefs[previous.id]?.focusEditor(true);
		}
	}

	function addColumn(): void {
		createRecord(ydoc, { parentId: block.id, blockType: 'column' }, CURRENT_USER);
	}

	// Columns stay a MIN_COLUMN_COUNT-to-MAX_COLUMN_COUNT layout
	// (block-capability-contract.md) — deleteRecord/createRecord themselves
	// enforce this floor/ceiling (issue #148's CodeRabbit review), so hiding
	// the controls here is purely a UX nicety (no point offering a button
	// that would just throw), not the only guard.
	function removeColumn(columnId: string): void {
		if (columns.length <= MIN_COLUMN_COUNT) return;
		deleteRecord(ydoc, columnId);
	}
</script>

<div
	class="my-1 flex flex-col gap-4 md:flex-row md:items-start md:gap-4"
	role="group"
	aria-label="Multi-column layout, {columns.length} columns"
	data-columns-block={block.id}
>
	{#each columns as column, columnIndex (column.id)}
		{@const siblings = columnBlocks[column.id] ?? []}
		<div
			class="min-w-0 flex-1 rounded-lg border border-dashed border-border/70 p-2"
			role="group"
			aria-label="Column {columnIndex + 1} of {columns.length}"
			data-block-container={column.id}
		>
			<div class="flex flex-col gap-1">
				{#each siblings as columnRecord, index (columnRecord.id)}
					{@const ytext = getRecordYText(ydoc, columnRecord.id)}

					{#if draggingBlockId && dropIndicatorParentId === column.id && dropIndicatorIndex === index}
						<div class="drop-indicator" aria-hidden="true"></div>
					{/if}
					<BlockRow
						block={columnRecord}
						{index}
						{siblings}
						parentId={column.id}
						{ydoc}
						{ytext}
						{linkTargets}
						{blockRefs}
						{draggingBlockId}
						{selectedBlockIds}
						{justNavigatedBlockId}
						{convertOptions}
						rowClass="flex items-start py-0.5"
						moveAriaLabel="Move block in column {columnIndex +
							1}. Drag, or use Arrow Up, Arrow Down, Home, End, Arrow Left (previous column), and Arrow Right (next column). Shift-click, Ctrl-click, or Shift-Arrow to select multiple blocks."
						placeholder={index === 0 ? 'Type in this column…' : ''}
						{onDragHandlePointerDown}
						{onDragHandleKeydown}
						{onDuplicateBlock}
						{onDeleteBlock}
						{onConvertBlock}
						{onCopyBlockLink}
						{onMoveBlockUp}
						{onMoveBlockDown}
						onFocusBlock={() => onFocusBlock(columnRecord.id)}
						onInputText={() => onInputText(columnRecord.id)}
						onEnter={() => handleEnter(column.id, columnRecord)}
						onBackspaceAtStart={() => handleBackspace(column.id, index)}
						onSlashKey={() => {}}
					/>
				{/each}
				{#if draggingBlockId && dropIndicatorParentId === column.id && dropIndicatorIndex === siblings.length}
					<div class="drop-indicator" aria-hidden="true"></div>
				{/if}
			</div>
			<div class="mt-1 flex items-center justify-between">
				<button
					type="button"
					onclick={() => void addColumnBlockAfter(column.id, siblings.at(-1)?.id)}
					class="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted hover:bg-surface hover:text-fg"
				>
					<Icon name="plus" size={12} />
					Add block
				</button>
				{#if columns.length > MIN_COLUMN_COUNT}
					<button
						type="button"
						onclick={() => removeColumn(column.id)}
						class="rounded px-1.5 py-1 text-xs text-muted hover:bg-surface hover:text-red-500"
						aria-label="Remove column {columnIndex + 1}"
					>
						<Icon name="trash" size={12} />
					</button>
				{/if}
			</div>
		</div>
	{/each}
	{#if columns.length < MAX_COLUMN_COUNT}
		<button
			type="button"
			onclick={addColumn}
			class="flex flex-shrink-0 items-center gap-1 self-start rounded-lg border border-dashed border-border/70 px-2 py-2 text-xs text-muted hover:bg-surface hover:text-fg md:self-stretch"
			aria-label="Add column"
		>
			<Icon name="plus" size={14} />
		</button>
	{/if}
</div>
