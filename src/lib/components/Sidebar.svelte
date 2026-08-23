<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { page } from '$app/state';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { getClientDoc } from '$lib/client/yjs-client';
	import {
		buildDocumentTree,
		deleteCollection,
		deleteDocument,
		listCollections,
		listDocuments
	} from '$lib/data/records';
	import { isDark, toggleTheme } from '$lib/client/theme';
	import type { CollectionMeta, DocumentMeta, DocumentTreeNode } from '$lib/data/types';
	import Icon from './Icon.svelte';

	let {
		initialDocuments = [],
		initialCollections = []
	}: {
		initialDocuments?: DocumentMeta[];
		initialCollections?: CollectionMeta[];
	} = $props();

	let clientDocs: DocumentMeta[] = $state([]);
	let clientCols: CollectionMeta[] = $state([]);

	// Prefer live client YDoc data once populated; fallback to initial layout data
	let documents = $derived(clientDocs.length > 0 ? clientDocs : (initialDocuments ?? []));
	let collections = $derived(clientCols.length > 0 ? clientCols : (initialCollections ?? []));

	let collapsed = $state(false);
	let darkMode = $state(false);
	let expandedDocIds: SvelteSet<string> = new SvelteSet();

	let ydoc: ReturnType<typeof getClientDoc> | undefined = $state();

	let documentTree = $derived(buildDocumentTree(documents));
	let currentPath = $derived(page.url.pathname);
	let currentDocId = $derived(
		currentPath.startsWith('/doc/') ? currentPath.slice('/doc/'.length).split('/')[0] : null
	);
	let currentTableId = $derived(
		currentPath.startsWith('/table/') ? currentPath.slice('/table/'.length).split('/')[0] : null
	);

	function refresh(): void {
		if (!ydoc) return;
		const docs = listDocuments(ydoc);
		const cols = listCollections(ydoc);
		clientDocs = docs;
		clientCols = cols;
	}

	onMount(() => {
		try {
			collapsed = localStorage.getItem('sidebar_collapsed') === 'true';
			darkMode = isDark();
		} catch {
			// ignore localStorage errors in non-browser or sandboxed environments
		}

		const doc = getClientDoc();
		ydoc = doc;
		refresh();

		const recordsMap = doc.getMap('records');
		const documentsMap = doc.getMap('documents');
		const collectionsMap = doc.getMap('collections');

		const observer = () => refresh();
		recordsMap.observeDeep(observer);
		documentsMap.observeDeep(observer);
		collectionsMap.observeDeep(observer);
		doc.on('update', observer);

		return () => {
			recordsMap.unobserveDeep(observer);
			documentsMap.unobserveDeep(observer);
			collectionsMap.unobserveDeep(observer);
			doc.off('update', observer);
		};
	});

	function toggleCollapse(): void {
		collapsed = !collapsed;
		try {
			localStorage.setItem('sidebar_collapsed', String(collapsed));
		} catch {
			// ignore localStorage errors
		}
	}

	function handleToggleTheme(): void {
		darkMode = toggleTheme();
	}

	function toggleDocExpand(id: string, e: MouseEvent): void {
		e.stopPropagation();
		e.preventDefault();
		if (expandedDocIds.has(id)) expandedDocIds.delete(id);
		else expandedDocIds.add(id);
	}

	async function handleNewDocument(parentId?: string): Promise<void> {
		const rawTitle = window.prompt('Document title:');
		if (rawTitle === null) return;
		const title = rawTitle.trim() || 'Untitled';

		try {
			const res = await fetch('/api/documents', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title, parentDocumentId: parentId })
			});
			if (res.ok) {
				const newDoc = await res.json();
				if (parentId) {
					expandedDocIds.add(parentId);
				}
				refresh();
				await invalidateAll();
				await goto(resolve('/doc/[id]', { id: newDoc.id }));
			} else {
				alert('Failed to create document');
			}
		} catch {
			alert('Failed to create document (network error)');
		}
	}

	async function handleNewCollection(): Promise<void> {
		const rawTitle = window.prompt('Collection title:');
		if (rawTitle === null) return;
		const title = rawTitle.trim() || 'Untitled Collection';

		try {
			const res = await fetch('/api/collections', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title })
			});
			if (res.ok) {
				const newCol = await res.json();
				refresh();
				await invalidateAll();
				await goto(resolve('/table/[id]', { id: newCol.id }));
			} else {
				alert('Failed to create collection');
			}
		} catch {
			alert('Failed to create collection (network error)');
		}
	}

	async function handleDeleteDocument(id: string, e: MouseEvent): Promise<void> {
		e.stopPropagation();
		e.preventDefault();
		if (!confirm('Are you sure you want to delete this document?')) return;
		if (ydoc) {
			deleteDocument(ydoc, id);
			refresh();
		}
		await invalidateAll();
		if (currentDocId === id) {
			await goto(resolve('/'));
		}
	}

	async function handleDeleteCollection(id: string, e: MouseEvent): Promise<void> {
		e.stopPropagation();
		e.preventDefault();
		if (!confirm('Are you sure you want to delete this collection?')) return;
		if (ydoc) {
			deleteCollection(ydoc, id);
			refresh();
		}
		await invalidateAll();
		if (currentTableId === id) {
			await goto(resolve('/'));
		}
	}
</script>

<aside
	class="sidebar flex flex-shrink-0 flex-col border-r border-border bg-sidebar-bg transition-all duration-200 ease-in-out select-none"
	class:w-59={!collapsed}
	class:w-11={collapsed}
	aria-label="Workspace sidebar"
>
	<!-- Header -->
	<div
		class="flex h-12 items-center justify-between border-b border-border px-2.5"
		class:justify-center={collapsed}
	>
		{#if !collapsed}
			<a
				href={resolve('/')}
				class="flex items-center gap-2 overflow-hidden font-display text-sm font-semibold tracking-tight text-ellipsis whitespace-nowrap text-fg hover:text-accent"
			>
				<Icon name="logo" size={18} class="flex-shrink-0 text-accent" />
				<span class="truncate">AgentSpace</span>
			</a>
			<button
				type="button"
				onclick={toggleCollapse}
				class="rounded p-1 text-muted transition-colors hover:bg-surface hover:text-fg"
				title="Collapse sidebar"
				aria-label="Collapse sidebar"
			>
				<Icon name="chevron-left" size={16} />
			</button>
		{:else}
			<button
				type="button"
				onclick={toggleCollapse}
				class="rounded p-1.5 text-muted transition-colors hover:bg-surface hover:text-accent"
				title="Expand sidebar"
				aria-label="Expand sidebar"
			>
				<Icon name="logo" size={20} class="text-accent" />
			</button>
		{/if}
	</div>

	<!-- Main Navigation Content -->
	{#if !collapsed}
		<div class="flex-1 overflow-y-auto px-2 py-3">
			<!-- Documents Section -->
			<div class="mb-5">
				<div
					class="group flex items-center justify-between px-2 py-1 text-xs font-semibold tracking-wider text-muted uppercase"
				>
					<span>Documents</span>
					<button
						type="button"
						onclick={() => handleNewDocument(currentDocId ?? undefined)}
						class="rounded p-0.5 opacity-70 transition-all hover:bg-surface hover:text-accent hover:opacity-100"
						title={currentDocId ? 'New sub-page' : 'New document'}
						aria-label="New document"
					>
						<Icon name="plus" size={14} />
					</button>
				</div>

				<div class="mt-1 space-y-0.5">
					{#snippet renderNode(node: DocumentTreeNode)}
						{@const isSelected = currentDocId === node.id}
						{@const hasChildren = node.children.length > 0}
						{@const isExpanded = expandedDocIds.has(node.id)}
						<div class="group/item relative flex items-center">
							<div
								class="flex flex-1 items-center rounded-md text-sm transition-colors"
								style="padding-left: {node.level * 16 + 4}px;"
								class:bg-surface={isSelected}
								class:text-accent={isSelected}
								class:font-semibold={isSelected}
								class:text-fg={!isSelected}
								class:hover:bg-surface={!isSelected}
							>
								{#if hasChildren}
									<button
										type="button"
										onclick={(e) => toggleDocExpand(node.id, e)}
										class="mr-1 p-0.5 text-muted hover:text-fg"
										aria-label={isExpanded ? 'Collapse sub-pages' : 'Expand sub-pages'}
									>
										<Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={14} />
									</button>
								{:else}
									<span class="mr-1 w-3.5 text-center text-xs text-muted/60">•</span>
								{/if}

								<a
									href={resolve('/doc/[id]', { id: node.id })}
									class="flex flex-1 items-center gap-1.5 truncate py-1 pr-1.5"
								>
									<Icon name="document" size={15} class="flex-shrink-0 opacity-75" />
									<span class="truncate">{node.title || 'Untitled'}</span>
								</a>

								<!-- Item Actions -->
								<div class="hidden items-center pr-1.5 group-hover/item:flex">
									<button
										type="button"
										onclick={(e) => {
											e.stopPropagation();
											e.preventDefault();
											handleNewDocument(node.id);
										}}
										class="p-0.5 text-muted hover:text-accent"
										title="Add sub-page"
										aria-label="Add sub-page"
									>
										<Icon name="plus" size={13} />
									</button>
									<button
										type="button"
										onclick={(e) => handleDeleteDocument(node.id, e)}
										class="p-0.5 text-muted hover:text-red-500"
										title="Delete document"
										aria-label="Delete document"
									>
										<Icon name="trash" size={13} />
									</button>
								</div>
							</div>
						</div>

						{#if hasChildren && (isExpanded || isSelected)}
							{#each node.children as child (child.id)}
								{@render renderNode(child)}
							{/each}
						{/if}
					{/snippet}

					{#each documentTree as rootDoc (rootDoc.id)}
						{@render renderNode(rootDoc)}
					{:else}
						<div class="px-2 py-1 text-xs text-muted italic">No documents yet</div>
					{/each}
				</div>
			</div>

			<!-- Collections Section -->
			<div class="mb-4">
				<div
					class="group flex items-center justify-between px-2 py-1 text-xs font-semibold tracking-wider text-muted uppercase"
				>
					<span>Collections</span>
					<button
						type="button"
						onclick={handleNewCollection}
						class="rounded p-0.5 opacity-70 transition-all hover:bg-surface hover:text-accent hover:opacity-100"
						title="New collection"
						aria-label="New collection"
					>
						<Icon name="plus" size={14} />
					</button>
				</div>

				<div class="mt-1 space-y-0.5">
					{#each collections as collection (collection.id)}
						{@const isSelected = currentTableId === collection.id}
						<div class="group/col flex items-center">
							<a
								href={resolve('/table/[id]', { id: collection.id })}
								class="flex flex-1 items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors"
								class:bg-surface={isSelected}
								class:text-accent={isSelected}
								class:font-semibold={isSelected}
								class:text-fg={!isSelected}
								class:hover:bg-surface={!isSelected}
							>
								<Icon name="table" size={15} class="flex-shrink-0 opacity-75" />
								<span class="truncate">{collection.title || 'Untitled'}</span>
							</a>
							<button
								type="button"
								onclick={(e) => handleDeleteCollection(collection.id, e)}
								class="hidden p-1 text-muted group-hover/col:block hover:text-red-500"
								title="Delete collection"
								aria-label="Delete collection"
							>
								<Icon name="trash" size={13} />
							</button>
						</div>
					{:else}
						<div class="px-2 py-1 text-xs text-muted italic">No collections yet</div>
					{/each}
				</div>
			</div>
		</div>
	{:else}
		<!-- Collapsed Icon Rail Shortcuts -->
		<div class="flex flex-1 flex-col items-center gap-3 py-3">
			<a
				href={resolve('/')}
				class="rounded p-2 text-muted transition-colors hover:bg-surface hover:text-accent"
				class:bg-surface={currentPath === '/' || currentDocId !== null}
				class:text-accent={currentPath === '/' || currentDocId !== null}
				title="Documents"
				aria-label="Documents"
			>
				<Icon name="document" size={18} />
			</a>
			<a
				href={resolve('/')}
				class="rounded p-2 text-muted transition-colors hover:bg-surface hover:text-accent"
				class:bg-surface={currentTableId !== null}
				class:text-accent={currentTableId !== null}
				title="Collections"
				aria-label="Collections"
			>
				<Icon name="table" size={18} />
			</a>
		</div>
	{/if}

	<!-- Footer Chrome -->
	<div class="border-t border-border p-2">
		{#if !collapsed}
			<div class="flex items-center justify-between text-xs text-muted">
				<div class="flex items-center gap-1">
					<a
						href={resolve('/settings/tokens')}
						class="flex items-center gap-1.5 rounded px-2 py-1.5 text-muted transition-colors hover:bg-surface hover:text-fg"
						class:text-accent={currentPath.startsWith('/settings')}
						title="Access tokens"
					>
						<Icon name="key" size={14} />
						<span>Tokens</span>
					</a>
					<a
						href={resolve('/audit')}
						class="flex items-center gap-1.5 rounded px-2 py-1.5 text-muted transition-colors hover:bg-surface hover:text-fg"
						class:text-accent={currentPath === '/audit'}
						title="Audit log"
					>
						<Icon name="history" size={14} />
						<span>Audit</span>
					</a>
				</div>
				<button
					type="button"
					onclick={handleToggleTheme}
					class="rounded p-1.5 text-muted transition-colors hover:bg-surface hover:text-fg"
					title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
					aria-label="Toggle theme"
				>
					<Icon name={darkMode ? 'sun' : 'moon'} size={15} />
				</button>
			</div>
		{:else}
			<div class="flex flex-col items-center gap-1">
				<a
					href={resolve('/settings/tokens')}
					class="rounded p-2 text-muted hover:bg-surface hover:text-fg"
					title="Tokens"
					aria-label="Tokens"
				>
					<Icon name="key" size={16} />
				</a>
				<a
					href={resolve('/audit')}
					class="rounded p-2 text-muted hover:bg-surface hover:text-fg"
					title="Audit log"
					aria-label="Audit log"
				>
					<Icon name="history" size={16} />
				</a>
				<button
					type="button"
					onclick={handleToggleTheme}
					class="rounded p-2 text-muted hover:bg-surface hover:text-fg"
					title="Toggle theme"
					aria-label="Toggle theme"
				>
					<Icon name={darkMode ? 'sun' : 'moon'} size={16} />
				</button>
			</div>
		{/if}
	</div>
</aside>
