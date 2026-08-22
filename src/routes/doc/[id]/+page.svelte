<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { resolve } from '$app/paths';
	import { getClientDoc } from '$lib/client/yjs-client';
	import { CURRENT_USER } from '$lib/client/actor';
	import {
		createRecord,
		deleteRecord,
		getDocument,
		getRecordYText,
		listDocuments,
		listRecordsForParent,
		setBlockType,
		setRecordChecked,
		setRecordCollapsed,
		setRecordReferencedId,
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
	import Icon from '$lib/components/Icon.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let ydoc: ReturnType<typeof getClientDoc> | undefined = $state();
	let currentDoc = $derived(ydoc ? getDocument(ydoc, data.documentId) : undefined);
	let title = $derived(currentDoc?.title ?? data.title);
	let blocks: WorkspaceRecord[] = $state([]);
	let slashMenuBlockId: string | null = $state(null);
	let slashQuery = $state('');
	let heldByOthers: Map<string, ActorId> = $state(new Map());
	let parentDocTitle: string | null = $state(null);

	interface BlockEditorHandle {
		render: () => void;
		applyFormat: (mark: keyof TextMarks, value?: unknown) => void;
		focusEditor: (atStart?: boolean) => void;
	}

	const blockRefs: Record<string, BlockEditorHandle | undefined> = {};

	function refresh(): void {
		if (!ydoc) return;
		blocks = listRecordsForParent(ydoc, data.documentId);
		const docMeta = getDocument(ydoc, data.documentId);
		if (docMeta?.parentDocumentId) {
			const parent = getDocument(ydoc, docMeta.parentDocumentId);
			parentDocTitle = parent?.title || 'Parent document';
		} else {
			parentDocTitle = null;
		}
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

	async function addBlockAfter(
		afterId?: string,
		blockType: BlockType = 'paragraph'
	): Promise<void> {
		if (!ydoc) return;
		const record = createRecord(
			ydoc,
			{ parentId: data.documentId, blockType, afterRecordId: afterId },
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

	function toggleTodoCheck(block: WorkspaceRecord): void {
		if (!ydoc) return;
		setRecordChecked(ydoc, block.id, !block.checked, CURRENT_USER);
	}

	function toggleCollapseState(block: WorkspaceRecord): void {
		if (!ydoc) return;
		setRecordCollapsed(ydoc, block.id, !block.collapsed, CURRENT_USER);
	}

	function handleLinkSyncedBlock(blockId: string): void {
		if (!ydoc) return;
		const targetId = window.prompt('Enter target Block Record ID to sync with:');
		if (targetId) {
			setRecordReferencedId(ydoc, blockId, targetId.trim(), CURRENT_USER);
		}
	}

	function handleLinkPage(blockId: string): void {
		if (!ydoc) return;
		const docId = window.prompt('Enter target Document ID:');
		if (docId) {
			setRecordReferencedId(ydoc, blockId, docId.trim(), CURRENT_USER);
		}
	}

	// Computed heading list for Table of Contents blocks
	let headings = $derived(
		blocks.filter((b) =>
			['heading', 'heading_1', 'heading_2', 'heading_3', 'heading_4'].includes(b.blockType ?? '')
		)
	);

	function getHeadingText(recordId: string): string {
		if (!ydoc) return '';
		const ytext = getRecordYText(ydoc, recordId);
		return ytext ? plainText(yTextToRichText(ytext)) : '';
	}

	function getHeadingLevel(blockType?: BlockType): number {
		switch (blockType) {
			case 'heading_1':
				return 1;
			case 'heading_2':
				return 2;
			case 'heading_3':
				return 3;
			case 'heading_4':
				return 4;
			default:
				return 1;
		}
	}

	// Helper for numbered lists to compute sequential item numbers
	function getNumberedListIndex(currentIndex: number): number {
		let num = 1;
		for (let i = currentIndex - 1; i >= 0; i--) {
			if (blocks[i].blockType === 'numbered_list_item') {
				num++;
			} else {
				break;
			}
		}
		return num;
	}
	async function handleTitleKeydown(e: KeyboardEvent): Promise<void> {
		if (e.key === 'Enter' || e.key === 'ArrowDown') {
			e.preventDefault();
			if (blocks.length > 0) {
				blockRefs[blocks[0].id]?.focusEditor(true);
			} else {
				await addBlockAfter(undefined);
			}
		}
	}
</script>

<svelte:head>
	<title>{title || 'Untitled'} · AgentSpace</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-6 py-10">
	<!-- Breadcrumb / Hierarchy nav -->
	<nav class="mb-4 flex items-center gap-1.5 text-xs text-muted">
		<a href={resolve('/')} class="flex items-center gap-1 transition-colors hover:text-accent">
			<span>Workspace</span>
		</a>
		{#if parentDocTitle}
			<span>/</span>
			<span class="truncate">{parentDocTitle}</span>
		{/if}
		<span>/</span>
		<span class="truncate font-medium text-fg">{title || 'Untitled'}</span>
	</nav>

	<!-- Document Title -->
	<input
		class="w-full border-none bg-transparent font-display text-3xl font-semibold tracking-tight text-fg outline-none placeholder:text-muted/50 focus:ring-0 md:text-4xl"
		value={title}
		oninput={handleTitleInput}
		onkeydown={handleTitleKeydown}
		placeholder="Untitled document"
	/>

	<!-- Blocks Canvas (Click anywhere below title to start writing) -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="mt-6 flex min-h-[350px] cursor-text flex-col gap-1 pb-16"
		onclick={(e) => {
			if (e.target === e.currentTarget) {
				if (blocks.length > 0) {
					blockRefs[blocks[blocks.length - 1].id]?.focusEditor(false);
				} else {
					addBlockAfter(undefined);
				}
			}
		}}
	>
		{#if blocks.length === 0}
			<button
				type="button"
				onclick={() => addBlockAfter(undefined)}
				class="w-full cursor-text py-2 text-left text-base font-normal text-muted/60 select-none hover:text-muted"
			>
				Type '/' for commands, or start typing...
			</button>
		{/if}
		{#each blocks as block, index (block.id)}
			{@const ytext = ydoc
				? block.blockType === 'synced_block' && block.referencedRecordId
					? getRecordYText(ydoc, block.referencedRecordId)
					: getRecordYText(ydoc, block.id)
				: undefined}
			{@const holder = heldByOthers.get(
				block.blockType === 'synced_block' && block.referencedRecordId
					? block.referencedRecordId
					: block.id
			)}
			{@const bt = block.blockType ?? 'paragraph'}

			<div class="group relative flex items-start py-0.5" id="block-{block.id}">
				<!-- Left Indicator / Control Gutter -->
				{#if bt === 'to_do'}
					<button
						type="button"
						onclick={() => toggleTodoCheck(block)}
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
				{:else if bt === 'bulleted_list_item' || bt === 'list-item'}
					<span
						class="mt-1 mr-2.5 flex h-4 w-3.5 flex-shrink-0 items-center justify-center font-bold text-muted select-none"
					>
						•
					</span>
				{:else if bt === 'numbered_list_item'}
					<span
						class="mt-1 mr-2 flex w-5 flex-shrink-0 items-center justify-end text-xs font-medium text-muted select-none"
					>
						{getNumberedListIndex(index)}.
					</span>
				{:else if bt === 'toggle'}
					<button
						type="button"
						onclick={() => toggleCollapseState(block)}
						class="mt-1 mr-1 flex h-4.5 w-4.5 flex-shrink-0 items-center justify-center rounded text-muted hover:bg-surface hover:text-fg"
						aria-label={block.collapsed ? 'Expand section' : 'Collapse section'}
					>
						<Icon name={block.collapsed ? 'chevron-right' : 'chevron-down'} size={14} />
					</button>
				{/if}

				<!-- Block Content -->
				<div class="min-w-0 flex-1">
					{#if holder}
						<!-- Held / Placeholder Block (M1 Design System) -->
						<div
							class="flex h-7 items-center gap-2 rounded-md bg-surface/40 px-2 py-1"
							title="{formatActor(holder)} is editing this block"
						>
							<span
								class="flex h-4.5 w-4.5 flex-shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-accent-fg"
							>
								{formatActor(holder).slice(0, 1).toUpperCase()}
							</span>
							<div class="shimmer-bar h-3 flex-1 rounded bg-surface"></div>
							<span class="text-[11px] font-medium text-muted">{formatActor(holder)} editing…</span>
						</div>
					{:else if bt === 'divider'}
						<div class="my-3 border-t border-border"></div>
					{:else if bt === 'callout'}
						<div class="flex gap-3 rounded-lg border border-border bg-surface p-3.5 shadow-xs">
							<Icon name="callout" size={18} class="mt-0.5 flex-shrink-0 text-accent" />
							<div class="min-w-0 flex-1">
								{#if ytext}
									<BlockEditor
										bind:this={blockRefs[block.id]}
										{ytext}
										placeholder="Callout note…"
										onInputText={() => handleBlockInput(block.id)}
										onEnter={() => addBlockAfter(block.id)}
										onBackspaceAtStart={() => handleBackspace(block, index)}
										onFocusBlock={() => claimBlockPresence(block.id)}
										onSlashKey={() => openSlashMenu(block.id)}
									/>
								{/if}
							</div>
						</div>
					{:else if bt === 'quote'}
						<div class="border-l-2 border-accent/60 py-0.5 pl-3.5 text-fg/90 italic">
							{#if ytext}
								<BlockEditor
									bind:this={blockRefs[block.id]}
									{ytext}
									placeholder="Quote…"
									onInputText={() => handleBlockInput(block.id)}
									onEnter={() => addBlockAfter(block.id)}
									onBackspaceAtStart={() => handleBackspace(block, index)}
									onFocusBlock={() => claimBlockPresence(block.id)}
									onSlashKey={() => openSlashMenu(block.id)}
								/>
							{/if}
						</div>
					{:else if bt === 'code'}
						<div class="rounded-md border border-border bg-surface p-3 font-mono text-sm">
							{#if ytext}
								<BlockEditor
									bind:this={blockRefs[block.id]}
									{ytext}
									class="font-mono text-[13.5px]"
									placeholder="Code snippet…"
									onInputText={() => handleBlockInput(block.id)}
									onEnter={() => addBlockAfter(block.id)}
									onBackspaceAtStart={() => handleBackspace(block, index)}
									onFocusBlock={() => claimBlockPresence(block.id)}
									onSlashKey={() => openSlashMenu(block.id)}
								/>
							{/if}
						</div>
					{:else if bt === 'table_of_contents'}
						<div class="my-2 rounded-lg border border-border bg-surface/60 p-4">
							<div
								class="flex items-center gap-2 text-xs font-semibold tracking-wider text-muted uppercase"
							>
								<Icon name="toc" size={15} class="text-accent" />
								<span>Table of contents</span>
							</div>
							<div class="mt-2 space-y-1 text-sm">
								{#each headings as h (h.id)}
									{@const level = getHeadingLevel(h.blockType)}
									{@const hText = getHeadingText(h.id)}
									<a
										href="#block-{h.id}"
										class="block text-muted transition-colors hover:text-accent"
										style="padding-left: {(level - 1) * 16}px;"
									>
										{hText || 'Untitled heading'}
									</a>
								{:else}
									<p class="text-xs text-muted italic">Add heading blocks to generate outline.</p>
								{/each}
							</div>
						</div>
					{:else if bt === 'synced_block'}
						<div class="rounded-md border border-dashed border-accent/40 bg-surface/30 p-2.5">
							<div class="mb-1 flex items-center justify-between text-[11px] text-muted">
								<span class="flex items-center gap-1 font-medium text-accent">
									<Icon name="sync" size={13} />
									<span>Synced Block</span>
								</span>
								<button
									type="button"
									onclick={() => handleLinkSyncedBlock(block.id)}
									class="hover:text-accent hover:underline"
								>
									{block.referencedRecordId
										? `ID: ${block.referencedRecordId.slice(0, 8)}…`
										: 'Set target ID'}
								</button>
							</div>
							{#if ytext}
								<BlockEditor
									bind:this={blockRefs[block.id]}
									{ytext}
									placeholder="Synced content…"
									onInputText={() => handleBlockInput(block.id)}
									onEnter={() => addBlockAfter(block.id)}
									onBackspaceAtStart={() => handleBackspace(block, index)}
									onFocusBlock={() => claimBlockPresence(block.referencedRecordId || block.id)}
									onSlashKey={() => openSlashMenu(block.id)}
								/>
							{:else}
								<p class="text-xs text-muted italic">
									Click 'Set target ID' to sync with an existing block record.
								</p>
							{/if}
						</div>
					{:else if bt === 'page-link' || bt === 'page_link'}
						{@const linkedDoc =
							block.referencedRecordId && ydoc
								? getDocument(ydoc, block.referencedRecordId)
								: undefined}
						<div class="my-1 rounded-lg border border-border bg-surface/50 p-2.5 shadow-xs">
							{#if linkedDoc}
								<div class="flex items-center justify-between">
									<a
										href={resolve('/doc/[id]', { id: linkedDoc.id })}
										class="flex items-center gap-2 text-sm font-medium text-fg transition-colors hover:text-accent"
									>
										<Icon name="document" size={16} class="flex-shrink-0 text-accent" />
										<span class="underline underline-offset-2"
											>{linkedDoc.title || 'Untitled Document'}</span
										>
									</a>
									<button
										type="button"
										onclick={() => handleLinkPage(block.id)}
										class="rounded px-2 py-0.5 text-xs text-muted hover:text-accent"
										title="Change target document"
									>
										Change
									</button>
								</div>
							{:else}
								<div class="flex items-center gap-2 text-xs text-muted">
									<Icon name="link" size={15} class="flex-shrink-0 text-accent" />
									<span>Link to page:</span>
									{#if ydoc}
										<select
											onchange={(e) => {
												const val = (e.target as HTMLSelectElement).value;
												if (val) setRecordReferencedId(ydoc!, block.id, val, CURRENT_USER);
											}}
											class="rounded border border-border bg-bg px-2 py-1 text-xs text-fg focus:border-accent"
										>
											<option value="">Select document…</option>
											{#each listDocuments(ydoc) as d (d.id)}
												{#if d.id !== data.documentId}
													<option value={d.id}>{d.title || 'Untitled'}</option>
												{/if}
											{/each}
										</select>
									{/if}
								</div>
							{/if}
						</div>
					{:else}
						<!-- Standard text blocks: headings, paragraph, to_do text, toggle text -->
						{#if ytext}
							<div
								class:line-through={bt === 'to_do' && block.checked}
								class:text-muted={bt === 'to_do' && block.checked}
							>
								<BlockEditor
									bind:this={blockRefs[block.id]}
									{ytext}
									class={bt === 'heading_1'
										? 'font-display text-2xl font-bold text-fg'
										: bt === 'heading_2' || bt === 'heading'
											? 'font-display text-xl font-semibold text-fg'
											: bt === 'heading_3'
												? 'font-display text-lg font-semibold text-fg'
												: bt === 'heading_4'
													? 'font-display text-base font-semibold text-fg'
													: 'text-base text-fg'}
									placeholder={index === 0 ? "Type '/' for commands, or start typing..." : ''}
									onInputText={() => handleBlockInput(block.id)}
									onEnter={() => addBlockAfter(block.id)}
									onBackspaceAtStart={() => handleBackspace(block, index)}
									onFocusBlock={() => claimBlockPresence(block.id)}
									onSlashKey={() => openSlashMenu(block.id)}
								/>
							</div>
						{/if}
					{/if}

					<!-- Slash Menu Popup -->
					{#if slashMenuBlockId === block.id}
						<SlashMenu
							query={slashQuery}
							onSelect={(newType) => selectSlashCommand(block.id, newType)}
							onClose={() => (slashMenuBlockId = null)}
						/>
					{/if}
				</div>

				<!-- Right Attribution Tag (Visible on hover) -->
				<span
					class="ml-3 hidden flex-shrink-0 self-center text-[11px] text-muted/70 group-hover:inline-block"
					title="Edited by {formatActor(block.lastEditedBy)} at {formatTimestamp(
						block.lastEditedAt
					)}"
				>
					{formatActor(block.lastEditedBy)}
				</span>
			</div>
		{/each}
	</div>

	<!-- Add Block Button -->
	<div class="mt-6 flex items-center gap-2">
		<button
			type="button"
			onclick={() => addBlockAfter(blocks.at(-1)?.id)}
			class="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent hover:text-accent"
		>
			<Icon name="plus" size={13} />
			<span>Add block</span>
		</button>
	</div>

	<!-- Footer Hint -->
	<footer class="mt-12 border-t border-border pt-4 text-xs text-muted">
		Formatting: <kbd class="rounded bg-surface px-1 py-0.5 font-mono">⌘/Ctrl+B</kbd> bold ·
		<kbd class="rounded bg-surface px-1 py-0.5 font-mono">I</kbd> italic ·
		<kbd class="rounded bg-surface px-1 py-0.5 font-mono">X</kbd> strikethrough ·
		<kbd class="rounded bg-surface px-1 py-0.5 font-mono">E</kbd> code ·
		<kbd class="rounded bg-surface px-1 py-0.5 font-mono">K</kbd> link. Type "/" for slash commands.
	</footer>
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
