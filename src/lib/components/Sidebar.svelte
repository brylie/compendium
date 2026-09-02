<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { page } from '$app/state';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { buildDocumentTree } from '$lib/data/records';
	import { isDark, toggleTheme } from '$lib/client/theme';
	import type { CollectionMeta, DocumentMeta, DocumentTreeNode, SpaceMeta } from '$lib/data/types';
	import Icon from './Icon.svelte';
	import PromptDialog from './PromptDialog.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import SpaceSwitcher from './SpaceSwitcher.svelte';

	let {
		initialDocuments = [],
		initialCollections = [],
		spaces = [],
		activeSpaceId
	}: {
		initialDocuments?: DocumentMeta[];
		initialCollections?: CollectionMeta[];
		spaces?: SpaceMeta[];
		activeSpaceId: string;
	} = $props();

	// Documents are catalog-backed (initialDocuments) only, never live — a
	// sharded Document's own meta entry doesn't live in the shared 'workspace'
	// doc this component used to observe (#120: every Document now has its
	// own shard). An explicit, accepted gap until Phase C's SSE feed (#121)
	// exists: creating/renaming/moving/deleting a Document needs a refresh to
	// show up in the sidebar, the same tradeoff already accepted for
	// Collections below. A Document's own content stays fully live once its
	// own shard connects (see doc/[id]/+page.svelte).
	let documents = $derived(initialDocuments ?? []);
	// Collections are catalog-backed (initialCollections) only, never live —
	// a sharded Collection's own meta entry doesn't live in the shared
	// 'workspace' doc this component observes, so there's nothing correct to
	// merge in here. An explicit, accepted gap until Phase C's SSE feed (#121)
	// exists: creating/renaming/deleting a Collection needs a refresh to show
	// up in the sidebar. A Collection's own content stays fully live once its
	// shard connects (see TableCollectionView etc).
	let collections = $derived(initialCollections ?? []);

	let collapsed = $state(false);
	let isMobile = $state(false);
	let mobileOpen = $state(false);
	let darkMode = $state(false);
	let sidebarElement: HTMLElement;
	let menuButton: HTMLButtonElement;
	let desktopFocusTarget = $state<HTMLButtonElement>();
	let expandedDocIds = new SvelteSet<string>();

	let createDialog: 'document' | 'collection' | null = $state(null);
	let pendingParentId: string | undefined = $state();
	let pendingDeletion: { kind: 'document' | 'collection'; id: string } | null = $state(null);
	let errorMessage: string | null = $state(null);

	let documentTree = $derived(buildDocumentTree(documents));
	let currentPath = $derived(page.url.pathname);
	let previousPath = $state<string | null>(null);
	let currentDocId = $derived(
		page.params.id && currentPath.includes('/doc/') ? page.params.id : null
	);
	let currentTableId = $derived(
		page.params.id && currentPath.includes('/table/') ? page.params.id : null
	);
	let expanded = $derived(!collapsed || isMobile);

	onMount(() => {
		const mediaQuery =
			typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 767px)') : null;
		let hasMeasuredViewport = false;
		const updateViewport = () => {
			const nextIsMobile = mediaQuery?.matches ?? false;
			const focusNeedsMoving =
				hasMeasuredViewport &&
				isMobile !== nextIsMobile &&
				sidebarElement?.contains(document.activeElement);
			isMobile = nextIsMobile;
			mobileOpen = false;
			if (focusNeedsMoving) void moveFocusAfterViewportChange(nextIsMobile);
			hasMeasuredViewport = true;
		};
		updateViewport();
		mediaQuery?.addEventListener('change', updateViewport);

		try {
			collapsed = localStorage.getItem('sidebar_collapsed') === 'true';
			darkMode = isDark();
		} catch {
			// ignore localStorage errors in non-browser or sandboxed environments
		}

		return () => mediaQuery?.removeEventListener('change', updateViewport);
	});

	$effect(() => {
		const routeChanged = previousPath !== null && currentPath !== previousPath;
		previousPath = currentPath;
		if (routeChanged && mobileOpen) void closeMobileNavigation();
	});

	function toggleCollapse(): void {
		collapsed = !collapsed;
		try {
			localStorage.setItem('sidebar_collapsed', String(collapsed));
		} catch {
			// ignore localStorage errors
		}
	}

	/** Opens the mobile navigation drawer and moves focus into it. */
	async function openMobileNavigation(): Promise<void> {
		mobileOpen = true;
		await tick();
		sidebarElement.querySelector<HTMLElement>('a, button')?.focus();
	}

	/** Closes the mobile navigation drawer and restores focus to its trigger. */
	async function closeMobileNavigation(): Promise<void> {
		mobileOpen = false;
		await tick();
		menuButton?.focus();
	}

	/** Moves focus to a visible control after the responsive sidebar changes mode. */
	async function moveFocusAfterViewportChange(nextIsMobile: boolean): Promise<void> {
		await tick();
		if (isMobile !== nextIsMobile) return;
		if (nextIsMobile) menuButton?.focus();
		else desktopFocusTarget?.focus();
	}

	/** Handles drawer dismissal and keeps keyboard focus within the mobile drawer. */
	function handleSidebarKeydown(event: KeyboardEvent): void {
		if (!isMobile || !mobileOpen) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			void closeMobileNavigation();
			return;
		}
		if (event.key !== 'Tab') return;

		const focusable = Array.from(
			sidebarElement.querySelectorAll<HTMLElement>(
				'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'
			)
		);
		if (focusable.length === 0) return;

		const first = focusable[0];
		const last = focusable.at(-1)!;
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
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

	function openNewDocument(parentId?: string): void {
		errorMessage = null;
		pendingParentId = parentId;
		createDialog = 'document';
	}

	async function createDocument(rawTitle: string): Promise<void> {
		const title = rawTitle.trim() || 'Untitled';
		const parentId = pendingParentId;
		createDialog = null;

		try {
			const res = await fetch('/api/documents', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title, parentDocumentId: parentId, spaceId: activeSpaceId })
			});
			if (res.ok) {
				const newDoc = await res.json();
				if (parentId) {
					expandedDocIds.add(parentId);
				}
				await invalidateAll();
				await goto(resolve('/space/[spaceId]/doc/[id]', { spaceId: activeSpaceId, id: newDoc.id }));
			} else {
				errorMessage = 'Failed to create document.';
			}
		} catch {
			errorMessage = 'Failed to create document. Check your connection and try again.';
		}
	}

	function openNewCollection(): void {
		errorMessage = null;
		createDialog = 'collection';
	}

	async function createCollection(rawTitle: string): Promise<void> {
		const title = rawTitle.trim() || 'Untitled Collection';
		createDialog = null;

		try {
			const res = await fetch('/api/collections', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title, spaceId: activeSpaceId })
			});
			if (res.ok) {
				const newCol = await res.json();
				await invalidateAll();
				await goto(
					resolve('/space/[spaceId]/table/[id]', { spaceId: activeSpaceId, id: newCol.id })
				);
			} else {
				errorMessage = 'Failed to create collection.';
			}
		} catch {
			errorMessage = 'Failed to create collection. Check your connection and try again.';
		}
	}

	function handleDeleteDocument(id: string, e: MouseEvent): void {
		e.stopPropagation();
		e.preventDefault();
		pendingDeletion = { kind: 'document', id };
	}

	function handleDeleteCollection(id: string, e: MouseEvent): void {
		e.stopPropagation();
		e.preventDefault();
		pendingDeletion = { kind: 'collection', id };
	}

	async function confirmDeletion(): Promise<void> {
		const deletion = pendingDeletion;
		if (!deletion) return;
		errorMessage = null;
		try {
			if (deletion.kind === 'document') {
				const id = deletion.id;
				// Routed through the service layer, not the raw CRDT primitive
				// against the shared doc: a Document lives in its own shard
				// since #120, which this component has no direct connection to
				// — and deletion needs to cascade the whole descendant subtree
				// across each of their own shards (see services/documents.ts).
				await fetch(`/api/documents/${id}`, { method: 'DELETE' });
				await invalidateAll();
				if (currentDocId === id) {
					await goto(resolve('/space/[spaceId]', { spaceId: activeSpaceId }));
				}
			} else {
				const id = deletion.id;
				// Routed through the service layer, not the raw CRDT primitive
				// against the shared doc: a Collection lives in its own shard
				// since #120, which this component has no direct connection to.
				await fetch(`/api/collections/${id}`, { method: 'DELETE' });
				await invalidateAll();
				if (currentTableId === id) {
					await goto(resolve('/space/[spaceId]', { spaceId: activeSpaceId }));
				}
			}
			pendingDeletion = null;
		} catch {
			errorMessage = `Could not delete the ${deletion.kind}. Please try again.`;
		}
	}
</script>

{#if mobileOpen}
	<button
		type="button"
		class="fixed inset-0 z-40 bg-black/30 md:hidden"
		aria-label="Close navigation"
		onclick={() => void closeMobileNavigation()}
	></button>
{/if}

<aside
	bind:this={sidebarElement}
	id="workspace-sidebar"
	class="sidebar fixed inset-y-0 left-0 z-50 flex h-dvh flex-col border-r border-border bg-sidebar-bg shadow-xl transition-all duration-200 ease-in-out select-none md:static md:z-auto md:h-auto md:flex-shrink-0 md:translate-x-0 md:shadow-none"
	class:w-59={expanded}
	class:w-11={!expanded}
	class:-translate-x-full={!mobileOpen}
	class:translate-x-0={mobileOpen}
	role={isMobile ? 'dialog' : 'navigation'}
	aria-modal={isMobile ? 'true' : undefined}
	aria-hidden={isMobile && !mobileOpen}
	inert={isMobile && !mobileOpen}
	aria-label="Workspace sidebar"
	onkeydown={handleSidebarKeydown}
>
	<!-- Header -->
	<div
		class="flex h-12 items-center justify-between border-b border-border px-2.5"
		class:justify-center={!expanded}
	>
		{#if expanded}
			<a
				href={resolve('/space/[spaceId]', { spaceId: activeSpaceId })}
				class="flex items-center gap-2 overflow-hidden font-display text-sm font-semibold tracking-tight text-ellipsis whitespace-nowrap text-fg hover:text-accent"
			>
				<Icon name="logo" size={18} class="flex-shrink-0 text-accent" />
				<span class="truncate">Compendium</span>
			</a>
			{#if isMobile}
				<button
					type="button"
					onclick={() => void closeMobileNavigation()}
					class="rounded p-1 text-muted transition-colors hover:bg-surface hover:text-fg"
					title="Close navigation"
					aria-label="Close navigation"
				>
					<Icon name="close" size={16} />
				</button>
			{:else}
				<button
					bind:this={desktopFocusTarget}
					type="button"
					onclick={toggleCollapse}
					class="rounded p-1 text-muted transition-colors hover:bg-surface hover:text-fg"
					title="Collapse sidebar"
					aria-label="Collapse sidebar"
				>
					<Icon name="chevron-left" size={16} />
				</button>
			{/if}
		{:else}
			<button
				bind:this={desktopFocusTarget}
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

	<!-- Space Switcher -->
	{#if expanded}
		<div class="border-b border-border px-2 py-2">
			<SpaceSwitcher {spaces} {activeSpaceId} />
		</div>
	{/if}

	<!-- Main Navigation Content -->
	{#if expanded}
		<div class="flex-1 overflow-y-auto px-2 py-3">
			<!-- Documents Section -->
			<div class="mb-5">
				<div
					class="group flex items-center justify-between px-2 py-1 text-xs font-semibold tracking-wider text-muted uppercase"
				>
					<span>Documents</span>
					<button
						type="button"
						onclick={() => openNewDocument(currentDocId ?? undefined)}
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
									href={resolve('/space/[spaceId]/doc/[id]', {
										spaceId: activeSpaceId,
										id: node.id
									})}
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
											openNewDocument(node.id);
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
						onclick={openNewCollection}
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
								href={resolve('/space/[spaceId]/table/[id]', {
									spaceId: activeSpaceId,
									id: collection.id
								})}
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
			<SpaceSwitcher {spaces} {activeSpaceId} collapsed />
			<a
				href={resolve('/space/[spaceId]', { spaceId: activeSpaceId })}
				class="rounded p-2 text-muted transition-colors hover:bg-surface hover:text-accent"
				class:bg-surface={currentTableId === null}
				class:text-accent={currentTableId === null}
				title="Documents"
				aria-label="Documents"
			>
				<Icon name="document" size={18} />
			</a>
			<a
				href={resolve('/space/[spaceId]', { spaceId: activeSpaceId })}
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
		{#if expanded}
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

	{#if errorMessage}
		<div
			class="mx-2 mb-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700"
			role="alert"
		>
			{errorMessage}
			<button type="button" class="ml-2 underline" onclick={() => (errorMessage = null)}
				>Dismiss</button
			>
		</div>
	{/if}
</aside>

<button
	bind:this={menuButton}
	type="button"
	class="fixed top-3 left-3 z-30 rounded-md border border-border bg-sidebar-bg p-2 text-muted shadow-sm transition-colors hover:bg-surface hover:text-fg md:hidden"
	aria-label="Open navigation"
	aria-controls="workspace-sidebar"
	aria-expanded={mobileOpen}
	onclick={() => void openMobileNavigation()}
>
	<Icon name="sidebar" size={18} />
</button>

<PromptDialog
	open={createDialog !== null}
	title={createDialog === 'collection' ? 'New collection' : 'New document'}
	label={createDialog === 'collection' ? 'Collection title' : 'Document title'}
	placeholder={createDialog === 'collection' ? 'Untitled Collection' : 'Untitled'}
	submitLabel="Create"
	onSubmit={(value) => {
		if (createDialog === 'collection') void createCollection(value);
		else void createDocument(value);
	}}
	onCancel={() => {
		createDialog = null;
		pendingParentId = undefined;
	}}
/>

<ConfirmDialog
	open={pendingDeletion !== null}
	title={pendingDeletion?.kind === 'collection' ? 'Delete collection?' : 'Delete document?'}
	message="This cannot be undone."
	confirmLabel="Delete"
	onConfirm={() => void confirmDeletion()}
	onCancel={() => (pendingDeletion = null)}
/>
