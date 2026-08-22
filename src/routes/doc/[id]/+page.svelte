<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { resolve } from '$app/paths';
	import { getClientDoc } from '$lib/client/yjs-client';
	import { CURRENT_USER } from '$lib/client/actor';
	import {
		createRecord,
		deleteRecord,
		getRecordYText,
		listRecordsForParent,
		setBlockType,
		updateDocumentTitle
	} from '$lib/data/records';
	import { plainText, yTextToRichText } from '$lib/data/richtext';
	import { formatActor, formatTimestamp } from '$lib/data/format';
	import {
		claimBlockPresence,
		releaseBlockPresence,
		subscribeHeldByOthers
	} from '$lib/client/presence';
	import type { ActorId, BlockType, TextMarks, WorkspaceRecord } from '$lib/data/types';
	import BlockEditor from './BlockEditor.svelte';
	import SlashMenu from './SlashMenu.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let title = $state(data.title);
	let blocks: WorkspaceRecord[] = $state([]);
	let slashMenuBlockId: string | null = $state(null);
	let slashQuery = $state('');
	let heldByOthers: Map<string, ActorId> = $state(new Map());

	interface BlockEditorHandle {
		render: () => void;
		applyFormat: (mark: keyof TextMarks, value?: unknown) => void;
		focusEditor: (atStart?: boolean) => void;
	}

	let ydoc: ReturnType<typeof getClientDoc> | undefined = $state();
	const blockRefs: Record<string, BlockEditorHandle | undefined> = {};

	function refresh(): void {
		if (!ydoc) return;
		blocks = listRecordsForParent(ydoc, data.documentId);
	}

	onMount(() => {
		const doc = getClientDoc();
		ydoc = doc;
		refresh();

		const recordsMap = doc.getMap('records');
		const documentsMap = doc.getMap('documents');
		const observer = () => refresh();
		recordsMap.observeDeep(observer);
		documentsMap.observeDeep(observer);

		const unsubscribePresence = subscribeHeldByOthers((held) => {
			heldByOthers = held;
		});

		return () => {
			recordsMap.unobserveDeep(observer);
			documentsMap.unobserveDeep(observer);
			unsubscribePresence();
			releaseBlockPresence();
		};
	});

	function handleTitleInput(event: Event): void {
		if (!ydoc) return;
		title = (event.target as HTMLInputElement).value;
		updateDocumentTitle(ydoc, data.documentId, title);
	}

	async function addBlockAfter(afterId?: string): Promise<void> {
		if (!ydoc) return;
		const record = createRecord(
			ydoc,
			{ parentId: data.documentId, blockType: 'paragraph', afterRecordId: afterId },
			CURRENT_USER
		);
		await tick();
		blockRefs[record.id]?.focusEditor(true);
	}

	async function handleBackspace(block: WorkspaceRecord, index: number): Promise<void> {
		if (!ydoc || blocks.length <= 1) return;
		const previous = blocks[index - 1];
		deleteRecord(ydoc, block.id);
		if (previous) {
			await tick();
			blockRefs[previous.id]?.focusEditor(false);
		}
	}

	function handleBlockInput(blockId: string): void {
		if (slashMenuBlockId !== blockId || !ydoc) return;
		const ytext = getRecordYText(ydoc, blockId);
		const text = ytext ? plainText(yTextToRichText(ytext)) : '';
		if (!text.startsWith('/')) {
			slashMenuBlockId = null;
			return;
		}
		slashQuery = text.slice(1);
	}

	function openSlashMenu(blockId: string): void {
		slashMenuBlockId = blockId;
		slashQuery = '';
	}

	function selectSlashCommand(blockId: string, blockType: BlockType): void {
		if (!ydoc) return;
		const ytext = getRecordYText(ydoc, blockId);
		if (ytext) {
			const doc = ytext.doc;
			const clear = () => ytext.delete(0, ytext.length);
			if (doc) doc.transact(clear);
			else clear();
		}
		setBlockType(ydoc, blockId, blockType, CURRENT_USER);
		slashMenuBlockId = null;
		tick().then(() => blockRefs[blockId]?.focusEditor(true));
	}
</script>

<svelte:head>
	<title>{title || 'Untitled'} · AgentSpace</title>
</svelte:head>

<main>
	<a class="back" href={resolve('/')}>← Workspace</a>
	<input class="title" value={title} oninput={handleTitleInput} placeholder="Untitled" />

	<div class="blocks">
		{#each blocks as block, index (block.id)}
			{@const ytext = ydoc ? getRecordYText(ydoc, block.id) : undefined}
			{@const holder = heldByOthers.get(block.id)}
			<div class="block block-{block.blockType}">
				{#if holder}
					<div class="placeholder" title="{formatActor(holder)} is editing this block">
						<span class="holder-avatar">{formatActor(holder).slice(0, 1).toUpperCase()}</span>
						<span class="shimmer"></span>
					</div>
				{:else if ytext}
					<div class="editor-swap">
						<BlockEditor
							bind:this={blockRefs[block.id]}
							{ytext}
							placeholder={index === 0 ? "Type '/' for commands…" : ''}
							onInputText={() => handleBlockInput(block.id)}
							onEnter={() => addBlockAfter(block.id)}
							onBackspaceAtStart={() => handleBackspace(block, index)}
							onFocusBlock={() => claimBlockPresence(block.id)}
							onSlashKey={() => openSlashMenu(block.id)}
						/>
					</div>
				{/if}
				{#if slashMenuBlockId === block.id}
					<SlashMenu query={slashQuery} onSelect={(bt) => selectSlashCommand(block.id, bt)} />
				{/if}
				<span
					class="attribution"
					title="Last edited by {formatActor(block.lastEditedBy)} at {formatTimestamp(
						block.lastEditedAt
					)}"
				>
					{formatActor(block.lastEditedBy)}
				</span>
			</div>
		{/each}
	</div>

	<button type="button" class="add-block" onclick={() => addBlockAfter(blocks.at(-1)?.id)}>
		+ Add block
	</button>

	<p class="hint">
		Formatting: ⌘/Ctrl+B bold · I italic · X strikethrough · E code · K link. Type "/" for commands.
	</p>
</main>

<style>
	main {
		max-width: 42rem;
		margin: 0 auto;
		padding: 2rem 1rem;
		font-family:
			system-ui,
			-apple-system,
			sans-serif;
	}
	.back {
		display: inline-block;
		margin-bottom: 1rem;
		color: #666;
		text-decoration: none;
	}
	.title {
		font-size: 2rem;
		font-weight: 700;
		border: none;
		outline: none;
		width: 100%;
		margin-bottom: 1.5rem;
	}
	.blocks {
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}
	.block {
		position: relative;
		padding-right: 4.5rem;
	}
	.block-heading :global(.block-editor) {
		font-size: 1.4rem;
		font-weight: 700;
	}
	.block-list-item :global(.block-editor) {
		padding-left: 1.2rem;
	}
	.block-list-item :global(.block-editor)::before {
		content: '•';
		position: absolute;
		left: 0;
	}
	.block-code :global(.block-editor) {
		font-family: ui-monospace, monospace;
		background: #f5f5f5;
		border-radius: 4px;
		padding: 0.5rem;
	}
	.placeholder {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.15rem 0;
		height: 1.4em;
	}
	.holder-avatar {
		width: 1.2rem;
		height: 1.2rem;
		border-radius: 50%;
		background: #7c5cff;
		color: white;
		font-size: 0.65rem;
		font-weight: 700;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}
	.shimmer {
		flex: 1;
		height: 0.9em;
		border-radius: 3px;
		background: linear-gradient(90deg, #eee 25%, #f6f6f6 50%, #eee 75%);
		background-size: 200% 100%;
		animation: shimmer 1.4s ease-in-out infinite;
	}
	@keyframes shimmer {
		0% {
			background-position: 200% 0;
		}
		100% {
			background-position: -200% 0;
		}
	}
	.editor-swap {
		animation: fade-in 0.25s ease;
	}
	@keyframes fade-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	.attribution {
		position: absolute;
		right: 0;
		top: 0.3rem;
		font-size: 0.7rem;
		color: #bbb;
	}
	.add-block {
		margin-top: 1rem;
		padding: 0.4rem 0.8rem;
		border: 1px dashed #ccc;
		border-radius: 4px;
		background: none;
		cursor: pointer;
		color: #666;
	}
	.hint {
		margin-top: 2rem;
		font-size: 0.75rem;
		color: #aaa;
	}
</style>
