<script lang="ts">
	import type { BlockType } from '$lib/data/types';

	const COMMANDS: { blockType: BlockType; label: string; keywords: string }[] = [
		{ blockType: 'paragraph', label: 'Text', keywords: 'paragraph text' },
		{ blockType: 'heading', label: 'Heading', keywords: 'heading title' },
		{ blockType: 'list-item', label: 'Bulleted list', keywords: 'list bullet item' },
		{ blockType: 'code', label: 'Code', keywords: 'code snippet' }
	];

	let { query, onSelect }: { query: string; onSelect: (blockType: BlockType) => void } = $props();

	let filtered = $derived(COMMANDS.filter((c) => c.keywords.includes(query.toLowerCase())));
</script>

<div class="slash-menu" role="listbox">
	{#each filtered as command (command.blockType)}
		<button
			type="button"
			role="option"
			aria-selected="false"
			onclick={() => onSelect(command.blockType)}
		>
			{command.label}
		</button>
	{:else}
		<div class="empty">No matches</div>
	{/each}
</div>

<style>
	.slash-menu {
		display: flex;
		flex-direction: column;
		border: 1px solid #ddd;
		border-radius: 6px;
		background: white;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
		margin: 0.25rem 0;
		overflow: hidden;
		width: fit-content;
	}
	button {
		text-align: left;
		padding: 0.4rem 0.75rem;
		border: none;
		background: none;
		cursor: pointer;
		font-size: 0.9rem;
	}
	button:hover {
		background: #f2f2f2;
	}
	.empty {
		padding: 0.4rem 0.75rem;
		color: #999;
		font-size: 0.9rem;
	}
</style>
