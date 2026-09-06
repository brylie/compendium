<script lang="ts">
	import { tick } from 'svelte';
	import type * as Y from 'yjs';
	import { CURRENT_USER } from '$lib/client/actor';
	import {
		createRecord,
		deleteRecord,
		getRecordYText,
		listRecordsForParent,
		setBlockType,
		setRecordChecked
	} from '$lib/data/record-ops';
	import { plainText, yTextToRichText } from '$lib/data/richtext';
	import type { InternalLinkTarget } from '$lib/data/links';
	import type { BlockType, WorkspaceRecord } from '$lib/data/types';
	import BlockEditor from './BlockEditor.svelte';
	import Icon from './Icon.svelte';

	interface BlockEditorHandle {
		focusEditor: (position?: boolean | number) => void;
		focusEditorAtLine: (edge: 'first' | 'last', clientX: number | null) => void;
	}

	let {
		block,
		ydoc,
		linkTargets,
		blockRefs,
		draggingBlockId,
		dropIndicatorParentId,
		dropIndicatorIndex,
		onFocusBlock,
		onDragHandlePointerDown,
		onDragHandleKeydown
	}: {
		block: WorkspaceRecord;
		ydoc: Y.Doc;
		linkTargets: Map<string, InternalLinkTarget>;
		blockRefs: Record<string, BlockEditorHandle | undefined>;
		draggingBlockId: string | null;
		dropIndicatorParentId: string | null;
		dropIndicatorIndex: number | null;
		onFocusBlock: (blockId: string) => void;
		onDragHandlePointerDown: (
			event: PointerEvent,
			blockId: string,
			parentId: string,
			index: number
		) => void;
		onDragHandleKeydown: (event: KeyboardEvent, blockId: string) => void;
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

	function numberedListIndex(columnId: string, currentIndex: number): number {
		const siblings = columnBlocks[columnId] ?? [];
		let num = 1;
		for (let i = currentIndex - 1; i >= 0; i--) {
			if (siblings[i].blockType === 'numbered_list_item') num++;
			else break;
		}
		return num;
	}

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

	function toggleTodoCheck(columnRecord: WorkspaceRecord): void {
		setRecordChecked(ydoc, columnRecord.id, !columnRecord.checked, CURRENT_USER);
	}

	function addColumn(): void {
		createRecord(ydoc, { parentId: block.id, blockType: 'column' }, CURRENT_USER);
	}

	// Columns stay a "2 or more" layout (block-capability-contract.md) — the
	// remove control simply isn't offered once only 2 remain, rather than
	// enforcing the floor at the data layer the way every other generic
	// delete_record/deleteRecord call in this app stays unconstrained.
	function removeColumn(columnId: string): void {
		if (columns.length <= 2) return;
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
					{@const bt = columnRecord.blockType ?? 'paragraph'}

					{#if draggingBlockId && dropIndicatorParentId === column.id && dropIndicatorIndex === index}
						<div class="drop-indicator" aria-hidden="true"></div>
					{/if}
					<div
						class="group relative flex items-start py-0.5"
						class:opacity-50={draggingBlockId === columnRecord.id}
						id="block-{columnRecord.id}"
						data-block-row
						data-block-parent={column.id}
					>
						<button
							type="button"
							class="mt-1 mr-1 flex h-5 w-5 flex-shrink-0 cursor-grab items-center justify-center rounded text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-surface hover:text-fg focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent active:cursor-grabbing"
							aria-label="Move block in column {columnIndex +
								1}. Drag, or use Arrow Up, Arrow Down, Home, End, Arrow Left (previous column), and Arrow Right (next column)."
							data-drag-handle={columnRecord.id}
							onpointerdown={(e) => onDragHandlePointerDown(e, columnRecord.id, column.id, index)}
							onkeydown={(e) => onDragHandleKeydown(e, columnRecord.id)}
						>
							<Icon name="grip" size={14} />
						</button>

						{#if bt === 'to_do'}
							<button
								type="button"
								onclick={() => toggleTodoCheck(columnRecord)}
								class="mt-1 mr-2 flex h-4.5 w-4.5 flex-shrink-0 items-center justify-center rounded border border-border bg-bg text-accent transition-colors hover:border-accent"
								class:bg-accent={columnRecord.checked}
								class:border-accent={columnRecord.checked}
								title={columnRecord.checked ? 'Mark as incomplete' : 'Mark as complete'}
								aria-label={columnRecord.checked ? 'Mark as incomplete' : 'Mark as complete'}
							>
								{#if columnRecord.checked}
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
								{numberedListIndex(column.id, index)}.
							</span>
						{/if}

						<div class="min-w-0 flex-1">
							{#if bt === 'divider'}
								<div class="my-3 border-t border-border"></div>
							{:else if bt === 'quote'}
								<div class="border-l-2 border-accent/60 py-0.5 pl-3.5 text-fg/90 italic">
									{#if ytext}
										<BlockEditor
											bind:this={blockRefs[columnRecord.id]}
											{ytext}
											recordId={columnRecord.id}
											{linkTargets}
											placeholder="Quote…"
											onInputText={() => {}}
											onEnter={() => handleEnter(column.id, columnRecord)}
											onBackspaceAtStart={() => handleBackspace(column.id, index)}
											onFocusBlock={() => onFocusBlock(columnRecord.id)}
											onSlashKey={() => {}}
											isFirstBlock={index === 0}
											isLastBlock={index === siblings.length - 1}
										/>
									{/if}
								</div>
							{:else}
								<div
									class:line-through={bt === 'to_do' && columnRecord.checked}
									class:text-muted={bt === 'to_do' && columnRecord.checked}
								>
									{#if ytext}
										<BlockEditor
											bind:this={blockRefs[columnRecord.id]}
											{ytext}
											recordId={columnRecord.id}
											{linkTargets}
											class={headingTextClass(bt)}
											placeholder={index === 0 ? 'Type in this column…' : ''}
											onInputText={() => {}}
											onEnter={() => handleEnter(column.id, columnRecord)}
											onBackspaceAtStart={() => handleBackspace(column.id, index)}
											onFocusBlock={() => onFocusBlock(columnRecord.id)}
											onSlashKey={() => {}}
											isFirstBlock={index === 0}
											isLastBlock={index === siblings.length - 1}
										/>
									{/if}
								</div>
							{/if}
						</div>
					</div>
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
				{#if columns.length > 2}
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
	<button
		type="button"
		onclick={addColumn}
		class="flex flex-shrink-0 items-center gap-1 self-start rounded-lg border border-dashed border-border/70 px-2 py-2 text-xs text-muted hover:bg-surface hover:text-fg md:self-stretch"
		aria-label="Add column"
	>
		<Icon name="plus" size={14} />
	</button>
</div>
