<script lang="ts">
	import { tick } from 'svelte';
	import type * as Y from 'yjs';
	import { CURRENT_USER } from '$lib/client/actor';
	import {
		createRecord,
		deleteRecord,
		getRecordYText,
		listRecordsForParent,
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

	// A toggle's own curated child-type subset (issue #227) — no reference/
	// structural/container types, matching BLOCK_CAPABILITIES.toggle
	// .childBlockTypes (types.ts's toggleChildBlockTypes) and
	// services/records.ts's own creation-time validation. Enter on a list item
	// continues the list, same convention as the top-level editor and
	// ColumnsBlock's own per-column child list, which this component mirrors.
	const LIST_BLOCK_TYPES: readonly BlockType[] = [
		'bulleted_list_item',
		'numbered_list_item',
		'to_do'
	];

	// No separate Yjs subscription of our own — see ColumnsBlock.svelte's own
	// doc comment on the identical pattern: +page.svelte's top-level
	// recordsMap.observeDeep already rebuilds `blocks` (and this component's
	// `block` prop) on any relevant mutation, so re-deriving from `ydoc` here
	// keyed off that prop churn is enough.
	let children = $derived(listRecordsForParent(ydoc, block.id));

	function isBlockTextEmpty(id: string): boolean {
		const ytext = getRecordYText(ydoc, id);
		return !ytext || plainText(yTextToRichText(ytext)).length === 0;
	}

	async function addChildAfter(
		afterId?: string,
		blockType: BlockType = 'paragraph'
	): Promise<void> {
		const record = createRecord(
			ydoc,
			{ parentId: block.id, afterRecordId: afterId, blockType },
			CURRENT_USER
		);
		await tick();
		blockRefs[record.id]?.focusEditor(true);
	}

	// Enter anywhere in a child creates a new child right after it — the "end
	// of the last child" case in block-capability-contract.md §3's toggle row
	// is just this same behavior applied to the last child, not special logic
	// of its own.
	async function handleEnter(childRecord: WorkspaceRecord): Promise<void> {
		const blockType = childRecord.blockType ?? 'paragraph';
		const isList = LIST_BLOCK_TYPES.includes(blockType);
		if (isList && isBlockTextEmpty(childRecord.id)) {
			setBlockType(ydoc, childRecord.id, 'paragraph', CURRENT_USER);
			await tick();
			blockRefs[childRecord.id]?.focusEditor(true);
			return;
		}
		await addChildAfter(childRecord.id, isList ? blockType : 'paragraph');
	}

	// Backspace at the start of the toggle's first child does nothing special
	// — it does not merge into the toggle's own summary line, matching
	// block-capability-contract.md §3 ("does not collapse the toggle").
	async function handleBackspace(index: number): Promise<void> {
		const current = children[index];
		const previous = children[index - 1];
		if (!current) return;
		if (!previous) return;

		if (isBlockTextEmpty(current.id)) {
			deleteRecord(ydoc, current.id);
			await tick();
			blockRefs[previous.id]?.focusEditor(true);
		}
	}
</script>

<div
	class="mt-0.5 ml-1 flex flex-col gap-0.5 border-l-2 border-border/50 py-0.5 pl-4"
	role="group"
	aria-label="Toggle contents"
	data-block-container={block.id}
>
	{#each children as childRecord, index (childRecord.id)}
		{@const ytext = getRecordYText(ydoc, childRecord.id)}

		{#if draggingBlockId && dropIndicatorParentId === block.id && dropIndicatorIndex === index}
			<div class="drop-indicator" aria-hidden="true"></div>
		{/if}
		<BlockRow
			block={childRecord}
			{index}
			siblings={children}
			parentId={block.id}
			{ydoc}
			{ytext}
			{linkTargets}
			{blockRefs}
			{draggingBlockId}
			{selectedBlockIds}
			{justNavigatedBlockId}
			{convertOptions}
			rowClass="flex items-start py-0.5"
			moveAriaLabel="Move block in toggle. Drag, or use Arrow Up, Arrow Down, Home, and End. Shift-click, Ctrl-click, or Shift-Arrow to select multiple blocks."
			placeholder={index === 0 ? 'Type in this toggle…' : ''}
			{onDragHandlePointerDown}
			{onDragHandleKeydown}
			{onDuplicateBlock}
			{onDeleteBlock}
			{onConvertBlock}
			{onCopyBlockLink}
			{onMoveBlockUp}
			{onMoveBlockDown}
			onFocusBlock={() => onFocusBlock(childRecord.id)}
			onInputText={() => onInputText(childRecord.id)}
			onEnter={() => handleEnter(childRecord)}
			onBackspaceAtStart={() => handleBackspace(index)}
			onSlashKey={() => {}}
		/>
	{/each}
	{#if draggingBlockId && dropIndicatorParentId === block.id && dropIndicatorIndex === children.length}
		<div class="drop-indicator" aria-hidden="true"></div>
	{/if}
	<button
		type="button"
		onclick={() => void addChildAfter(children.at(-1)?.id)}
		class="flex items-center gap-1 self-start rounded px-1.5 py-1 text-xs text-muted hover:bg-surface hover:text-fg"
	>
		<Icon name="plus" size={12} />
		Add block
	</button>
</div>
