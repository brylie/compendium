<script lang="ts">
	import type * as Y from 'yjs';
	import { getRecordYText } from '$lib/data/record-ops';
	import { plainText, yTextToRichText } from '$lib/data/richtext';
	import type { BlockType, WorkspaceRecord } from '$lib/data/types';
	import Icon from './Icon.svelte';

	// Document-level List View / outline panel (issue #152) — every block in
	// true document order (including blocks nested inside columns), indented
	// by heading hierarchy, with a click focusing and scrolling to the
	// corresponding block. Distinct from the inline `table_of_contents` block
	// type, which only lists headings and lives inside the document flow
	// itself rather than as a persistent panel.
	let {
		open,
		flatBlocks,
		ydoc,
		activeBlockId,
		onSelect,
		onClose
	}: {
		open: boolean;
		flatBlocks: { record: WorkspaceRecord; depth: number }[];
		ydoc: Y.Doc | undefined;
		activeBlockId: string | null;
		onSelect: (blockId: string) => void;
		onClose: () => void;
	} = $props();

	const HEADING_LEVELS: Partial<Record<BlockType, number>> = {
		heading_1: 1,
		heading_2: 2,
		heading_3: 3,
		heading_4: 4
	};

	// A short, human-readable label for a block that has no meaningful text of
	// its own (or none yet) — every BlockType gets an entry so the outline
	// never renders a bare blank row for a structural block.
	const STRUCTURAL_LABELS: Partial<Record<BlockType, string>> = {
		divider: 'Divider',
		table: 'Table',
		table_of_contents: 'Table of contents',
		synced_block: 'Synced block',
		page_link: 'Page link',
		embed: 'Embed',
		collection_view: 'Collection view',
		bookmark: 'Bookmark',
		child_pages: 'Child pages',
		columns: 'Columns',
		column: 'Column'
	};

	interface OutlineRow {
		id: string;
		blockType?: BlockType;
		label: string;
		indent: number;
		isHeading: boolean;
	}

	function labelFor(record: WorkspaceRecord): string {
		if (record.blockType === 'bookmark') {
			const trimmedTitle = record.bookmarkMetadata?.title?.trim();
			if (trimmedTitle) return trimmedTitle;
			if (record.url) return record.url;
			return STRUCTURAL_LABELS.bookmark!;
		}
		const structural = record.blockType ? STRUCTURAL_LABELS[record.blockType] : undefined;
		if (structural) return structural;
		if (!ydoc) return '';
		const ytext = getRecordYText(ydoc, record.id);
		const text = ytext ? plainText(yTextToRichText(ytext)).trim() : '';
		if (text.length === 0) return 'Empty block';
		return text.length > 80 ? `${text.slice(0, 80)}…` : text;
	}

	// Nests every non-heading block under the deepest currently-open heading
	// (a heading closes any open heading at its own level or deeper before
	// pushing itself), on top of `depth`'s own container nesting — this is
	// what gives the outline both "heading hierarchy" and "every block in
	// order" at once, per the issue's own scope.
	let rows: OutlineRow[] = $derived.by(() => {
		const result: OutlineRow[] = [];
		const headingStack: number[] = [];
		for (const { record, depth } of flatBlocks) {
			const level = record.blockType ? HEADING_LEVELS[record.blockType] : undefined;
			if (level !== undefined) {
				while (headingStack.length > 0 && headingStack[headingStack.length - 1] >= level) {
					headingStack.pop();
				}
				headingStack.push(level);
			}
			const headingIndent = level !== undefined ? headingStack.length - 1 : headingStack.length;
			result.push({
				id: record.id,
				blockType: record.blockType,
				label: labelFor(record),
				indent: depth + headingIndent,
				isHeading: level !== undefined
			});
		}
		return result;
	});
</script>

{#if open}
	<div
		class="fixed top-0 right-0 z-40 flex h-full w-72 flex-col border-l border-border bg-sidebar-bg shadow-lg"
		role="region"
		aria-label="Document outline"
	>
		<div class="flex items-center justify-between border-b border-border px-3 py-2.5">
			<h2 class="text-sm font-semibold text-fg">List View</h2>
			<button
				type="button"
				onclick={onClose}
				class="rounded p-1 text-muted hover:bg-surface hover:text-fg"
				aria-label="Close outline"
			>
				<Icon name="close" size={16} />
			</button>
		</div>
		<nav class="flex-1 overflow-y-auto p-2" aria-label="Blocks in document order">
			{#if rows.length === 0}
				<p class="px-2 py-4 text-xs text-muted italic">No blocks yet.</p>
			{:else}
				<ul role="list" class="space-y-0.5">
					{#each rows as row (row.id)}
						<li>
							<button
								type="button"
								onclick={() => onSelect(row.id)}
								class="block w-full truncate rounded px-2 py-1 text-left text-sm hover:bg-surface"
								class:font-semibold={row.isHeading}
								class:text-fg={row.isHeading}
								class:text-muted={!row.isHeading}
								class:bg-surface={activeBlockId === row.id}
								class:text-accent={activeBlockId === row.id}
								style="padding-left: {8 + row.indent * 14}px;"
								title={row.label}
							>
								{row.label}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</nav>
	</div>
{/if}
