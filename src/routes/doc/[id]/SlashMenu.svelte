<script lang="ts">
	import { onMount } from 'svelte';
	import type { BlockType } from '$lib/data/types';
	import Icon from '$lib/components/Icon.svelte';

	interface Command {
		blockType: BlockType;
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
			| 'link';
		keywords: string;
	}

	const COMMANDS: Command[] = [
		{
			blockType: 'paragraph',
			label: 'Text',
			description: 'Just start writing with plain text.',
			icon: 'document',
			keywords: 'paragraph text plain'
		},
		{
			blockType: 'heading_1',
			label: 'Heading 1',
			description: 'Large section heading.',
			icon: 'heading-1',
			keywords: 'heading 1 title h1 large'
		},
		{
			blockType: 'heading_2',
			label: 'Heading 2',
			description: 'Medium section heading.',
			icon: 'heading-2',
			keywords: 'heading 2 section h2 medium'
		},
		{
			blockType: 'heading_3',
			label: 'Heading 3',
			description: 'Small section heading.',
			icon: 'heading-3',
			keywords: 'heading 3 subhead h3 small'
		},
		{
			blockType: 'heading_4',
			label: 'Heading 4',
			description: 'Sub-heading.',
			icon: 'heading-4',
			keywords: 'heading 4 h4'
		},
		{
			blockType: 'bulleted_list_item',
			label: 'Bulleted list',
			description: 'Create a simple bulleted list.',
			icon: 'list-bullet',
			keywords: 'bulleted list bullet item ul'
		},
		{
			blockType: 'numbered_list_item',
			label: 'Numbered list',
			description: 'Create an ordered numbered list.',
			icon: 'list-number',
			keywords: 'numbered list number ordered item ol'
		},
		{
			blockType: 'to_do',
			label: 'To-do list',
			description: 'Track tasks with a to-do checkbox.',
			icon: 'checkbox',
			keywords: 'to do todo task check checkbox checkbox-checked'
		},
		{
			blockType: 'callout',
			label: 'Callout',
			description: 'Highlight key notes and warnings.',
			icon: 'callout',
			keywords: 'callout note alert warning info tip box'
		},
		{
			blockType: 'quote',
			label: 'Quote',
			description: 'Capture a quotation.',
			icon: 'quote',
			keywords: 'quote blockquote citation'
		},
		{
			blockType: 'toggle',
			label: 'Toggle list',
			description: 'Hide or show content inside.',
			icon: 'toggle',
			keywords: 'toggle collapse expand details'
		},
		{
			blockType: 'code',
			label: 'Code',
			description: 'Capture a code snippet with monospace font.',
			icon: 'code',
			keywords: 'code snippet pre snippet program'
		},
		{
			blockType: 'divider',
			label: 'Divider',
			description: 'Visually divide sections with a line.',
			icon: 'divider',
			keywords: 'divider hr line rule separate'
		},
		{
			blockType: 'table_of_contents',
			label: 'Table of contents',
			description: 'Live outline of headings in this document.',
			icon: 'toc',
			keywords: 'table of contents toc outline summary headings'
		},
		{
			blockType: 'synced_block',
			label: 'Synced block',
			description: 'Reference content from another block.',
			icon: 'sync',
			keywords: 'synced block sync reference mirror link'
		},
		{
			blockType: 'page_link',
			label: 'Page link',
			description: 'Link to another document.',
			icon: 'link',
			keywords: 'page link document subpage wiki mention reference'
		}
	];

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
			return c.keywords.includes(q) || c.label.toLowerCase().includes(q);
		})
	);

	$effect(() => {
		// Reset selection when filtered items change
		if (selectedIndex >= filtered.length) {
			selectedIndex = Math.max(0, filtered.length - 1);
		}
	});

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			selectedIndex = (selectedIndex + 1) % Math.max(1, filtered.length);
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			selectedIndex = (selectedIndex - 1 + filtered.length) % Math.max(1, filtered.length);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			if (filtered[selectedIndex]) {
				onSelect(filtered[selectedIndex].blockType);
			}
		} else if (e.key === 'Escape') {
			e.preventDefault();
			onClose?.();
		}
	}

	onMount(() => {
		window.addEventListener('keydown', handleKeydown);
		return () => window.removeEventListener('keydown', handleKeydown);
	});
</script>

<div
	class="absolute z-50 mt-1 max-h-80 w-72 overflow-y-auto rounded-lg border border-border bg-bg p-1 shadow-lg ring-1 ring-black/5"
	role="listbox"
	aria-label="Slash commands"
>
	<div class="px-2 py-1 text-[11px] font-medium tracking-wider text-muted uppercase">
		Basic blocks
	</div>

	{#each filtered as command, index (command.blockType)}
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
	{:else}
		<div class="px-3 py-2 text-xs text-muted italic">No matching commands</div>
	{/each}
</div>
