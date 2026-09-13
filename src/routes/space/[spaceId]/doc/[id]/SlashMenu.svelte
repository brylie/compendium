<script lang="ts">
	import { onMount } from 'svelte';
	import type { BlockType } from '$lib/data/types';
	import { BLOCK_CAPABILITIES } from '$lib/data/block-capabilities';
	import Icon from '$lib/components/Icon.svelte';

	interface Command {
		blockType: BlockType;
		category: CommandCategory;
		label: string;
		description: string;
		icon:
			| 'document'
			| 'heading-1'
			| 'heading-2'
			| 'heading-3'
			| 'heading-4'
			| 'list-bullet'
			| 'list-number'
			| 'checkbox'
			| 'callout'
			| 'quote'
			| 'toggle'
			| 'code'
			| 'divider'
			| 'toc'
			| 'sync'
			| 'link'
			| 'table'
			| 'child-pages'
			| 'columns';
		aliases: string[];
	}

	type CommandCategory = 'Writing' | 'Structure' | 'Media' | 'Data' | 'Reuse';

	const CATEGORY_ORDER: CommandCategory[] = ['Writing', 'Structure', 'Media', 'Data', 'Reuse'];

	// Every insertable command's blockType/category/icon/aliases — UI-only
	// presentation concerns that have no MCP-facing equivalent. `label` and
	// `description` are deliberately NOT repeated here: they come from
	// `BLOCK_CAPABILITIES` below (issue #29) so this menu and the MCP
	// `list_block_types` discovery tool can't drift on that text. `column` has
	// no entry — it's never directly insertable from this menu (created
	// automatically as part of a Columns block).
	const COMMAND_DEFINITIONS: Omit<Command, 'label' | 'description'>[] = [
		{
			blockType: 'paragraph',
			category: 'Writing',
			icon: 'document',
			aliases: ['paragraph', 'text', 'plain', 'p']
		},
		{
			blockType: 'heading_1',
			category: 'Writing',
			icon: 'heading-1',
			aliases: ['heading 1', 'title', 'h1', 'large']
		},
		{
			blockType: 'heading_2',
			category: 'Writing',
			icon: 'heading-2',
			aliases: ['heading 2', 'section', 'h2', 'medium']
		},
		{
			blockType: 'heading_3',
			category: 'Writing',
			icon: 'heading-3',
			aliases: ['heading 3', 'subhead', 'h3', 'small']
		},
		{
			blockType: 'heading_4',
			category: 'Writing',
			icon: 'heading-4',
			aliases: ['heading 4', 'h4', 'subheading']
		},
		{
			blockType: 'bulleted_list_item',
			category: 'Writing',
			icon: 'list-bullet',
			aliases: ['bulleted list', 'bullet', 'item', 'ul', 'unordered list']
		},
		{
			blockType: 'numbered_list_item',
			category: 'Writing',
			icon: 'list-number',
			aliases: ['numbered list', 'number', 'ordered list', 'item', 'ol']
		},
		{
			blockType: 'to_do',
			category: 'Writing',
			icon: 'checkbox',
			aliases: ['to do', 'todo', 'task', 'check', 'checkbox', 'checklist']
		},
		{
			blockType: 'callout',
			category: 'Writing',
			icon: 'callout',
			aliases: ['callout', 'note', 'alert', 'warning', 'info', 'tip', 'box']
		},
		{
			blockType: 'quote',
			category: 'Writing',
			icon: 'quote',
			aliases: ['quote', 'blockquote', 'citation']
		},
		{
			blockType: 'toggle',
			category: 'Structure',
			icon: 'toggle',
			aliases: ['toggle', 'collapsible', 'collapse', 'expand', 'details']
		},
		{
			blockType: 'columns',
			category: 'Structure',
			icon: 'columns',
			aliases: ['columns', 'column', 'layout', 'side by side', 'multi-column']
		},
		{
			blockType: 'code',
			category: 'Media',
			icon: 'code',
			aliases: ['code', 'snippet', 'pre', 'program']
		},
		{
			blockType: 'divider',
			category: 'Structure',
			icon: 'divider',
			aliases: ['divider', 'hr', 'line', 'rule', 'separator']
		},
		{
			blockType: 'table_of_contents',
			category: 'Structure',
			icon: 'toc',
			aliases: ['table of contents', 'toc', 'outline', 'summary', 'headings']
		},
		{
			blockType: 'child_pages',
			category: 'Structure',
			icon: 'child-pages',
			aliases: ['child pages', 'page tree', 'subpages', 'sub-pages', 'children', 'index']
		},
		{
			blockType: 'synced_block',
			category: 'Reuse',
			icon: 'sync',
			aliases: ['synced block', 'sync', 'reference', 'mirror', 'linked block']
		},
		{
			blockType: 'page_link',
			category: 'Reuse',
			icon: 'link',
			aliases: ['page link', 'document', 'subpage', 'wiki', 'mention', 'reference']
		},
		{
			blockType: 'collection_view',
			category: 'Data',
			icon: 'table',
			aliases: ['collection view', 'table view', 'board', 'kanban', 'calendar', 'database']
		},
		{
			blockType: 'table',
			category: 'Data',
			icon: 'table',
			aliases: ['table', 'grid', 'rows', 'columns']
		},
		{
			blockType: 'embed',
			category: 'Media',
			icon: 'link',
			aliases: ['embed', 'media', 'video', 'image', 'url']
		}
	];

	const COMMANDS: Command[] = COMMAND_DEFINITIONS.map((definition) => ({
		...definition,
		label: BLOCK_CAPABILITIES[definition.blockType].label,
		description: BLOCK_CAPABILITIES[definition.blockType].description
	}));

	let {
		query,
		onSelect,
		onClose
	}: {
		query: string;
		onSelect: (blockType: BlockType) => void;
		onClose?: () => void;
	} = $props();

	let selectedIndex = $state(0);

	let filtered = $derived(
		COMMANDS.filter((c) => {
			const q = query.toLowerCase().trim();
			if (!q) return true;
			return c.label.toLowerCase().includes(q) || c.aliases.some((alias) => alias.includes(q));
		})
	);

	let categorized = $derived(
		CATEGORY_ORDER.map((category) => ({
			category,
			commands: filtered.filter((command) => command.category === category)
		})).filter((group) => group.commands.length > 0)
	);

	let visibleCommands = $derived(categorized.flatMap((group) => group.commands));

	$effect(() => {
		// Reset selection when filtered items change
		if (selectedIndex >= visibleCommands.length) {
			selectedIndex = Math.max(0, visibleCommands.length - 1);
		}
	});

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			e.stopPropagation();
			selectedIndex = (selectedIndex + 1) % Math.max(1, visibleCommands.length);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			e.stopPropagation();
			selectedIndex =
				(selectedIndex - 1 + visibleCommands.length) % Math.max(1, visibleCommands.length);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			e.stopPropagation();
			if (visibleCommands[selectedIndex]) {
				onSelect(visibleCommands[selectedIndex].blockType);
			}
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			onClose?.();
		}
	}

	onMount(() => {
		// Capture phase + stopPropagation: this menu only exists while a block
		// is focused, and BlockEditor's own keydown handler (bound directly on
		// that contenteditable) would otherwise see these same keys first —
		// e.g. Enter would both select a command here AND split the block
		// there. Capturing on window intercepts before the event ever reaches
		// the block's element.
		window.addEventListener('keydown', handleKeydown, true);
		return () => window.removeEventListener('keydown', handleKeydown, true);
	});
</script>

<div
	class="absolute z-50 mt-1 max-h-80 w-72 overflow-y-auto rounded-lg border border-border bg-bg p-1 shadow-lg ring-1 ring-black/5"
	role="listbox"
	aria-label="Slash commands"
>
	{#each categorized as group (group.category)}
		<div class="px-2 pt-2 pb-1 text-[11px] font-medium tracking-wider text-muted uppercase">
			{group.category}
		</div>
		{#each group.commands as command (command.blockType)}
			{@const index = visibleCommands.indexOf(command)}
			{@const isActive = index === selectedIndex}
			<button
				type="button"
				role="option"
				aria-selected={isActive}
				onclick={() => onSelect(command.blockType)}
				onmouseenter={() => (selectedIndex = index)}
				class="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors"
				class:bg-surface={isActive}
				class:text-accent={isActive}
				class:text-fg={!isActive}
			>
				<div
					class="flex h-6 w-6 items-center justify-center rounded border border-border bg-surface text-muted"
					class:text-accent={isActive}
				>
					<Icon name={command.icon} size={14} />
				</div>
				<div class="min-w-0 flex-1">
					<div class="leading-none font-medium">{command.label}</div>
					<div class="mt-0.5 truncate text-xs text-muted">{command.description}</div>
				</div>
			</button>
		{/each}
	{:else}
		<div class="px-3 py-2 text-xs text-muted italic">No matching commands</div>
	{/each}
</div>
