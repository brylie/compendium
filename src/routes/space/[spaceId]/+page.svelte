<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { buildDocumentTree } from '$lib/data/document-ops';
	import type { DocumentTreeNode } from '$lib/data/types';
	import Icon from '$lib/components/Icon.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let docTree = $derived(buildDocumentTree(data.documents));
	let spaceId = $derived(page.params.spaceId!);
</script>

<svelte:head>
	<title>Workspace · Compendium</title>
</svelte:head>

<div class="mx-auto max-w-4xl px-6 py-10">
	<header class="mb-10">
		<h1 class="font-display text-3xl font-semibold tracking-tight text-fg">Workspace</h1>
		<p class="mt-2 text-sm text-muted">
			Unified CRDT workspace for human notes and real-time MCP agent collaboration.
		</p>
	</header>

	{#if form?.error}
		<div
			class="mb-6 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm text-red-700 dark:text-red-300"
			role="alert"
		>
			{form.error}
		</div>
	{/if}

	<div class="grid grid-cols-1 gap-8 md:grid-cols-2">
		<!-- Documents Card -->
		<section class="rounded-xl border border-border bg-surface/50 p-5 shadow-xs">
			<div class="flex items-center justify-between border-b border-border/70 pb-3">
				<div class="flex items-center gap-2">
					<Icon name="document" size={18} class="text-accent" />
					<h2 class="font-display text-lg font-semibold text-fg">Documents</h2>
				</div>
				<span class="text-xs text-muted">{data.documents.length} total</span>
			</div>

			<div class="my-4 max-h-72 space-y-1 overflow-y-auto">
				{#snippet renderTree(nodes: DocumentTreeNode[])}
					{#each nodes as node (node.id)}
						<div>
							<a
								href={resolve('/space/[spaceId]/doc/[id]', { spaceId, id: node.id })}
								class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg transition-colors hover:bg-surface hover:text-accent"
								style="padding-left: {node.level * 16 + 8}px;"
							>
								<Icon name="document" size={15} class="flex-shrink-0 text-muted" />
								<span class="truncate">{node.title || 'Untitled'}</span>
							</a>
							{#if node.children.length > 0}
								{@render renderTree(node.children)}
							{/if}
						</div>
					{/each}
				{/snippet}

				{#if docTree.length > 0}
					{@render renderTree(docTree)}
				{:else}
					<p class="py-4 text-center text-sm text-muted italic">No documents created yet.</p>
				{/if}
			</div>

			<form method="POST" action="?/createDocument" class="mt-4 flex gap-2">
				<input
					type="text"
					name="title"
					placeholder="New document title…"
					required
					class="flex-1 rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
				/>
				<button
					type="submit"
					class="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition-opacity hover:opacity-90"
				>
					<Icon name="plus" size={14} />
					<span>Create</span>
				</button>
			</form>
		</section>

		<!-- Collections Card -->
		<section class="rounded-xl border border-border bg-surface/50 p-5 shadow-xs">
			<div class="flex items-center justify-between border-b border-border/70 pb-3">
				<div class="flex items-center gap-2">
					<Icon name="table" size={18} class="text-accent" />
					<h2 class="font-display text-lg font-semibold text-fg">Collections</h2>
				</div>
				<span class="text-xs text-muted">{data.collections.length} total</span>
			</div>

			<div class="my-4 max-h-72 space-y-1 overflow-y-auto">
				{#each data.collections as collection (collection.id)}
					<a
						href={resolve('/space/[spaceId]/table/[id]', { spaceId, id: collection.id })}
						class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-fg transition-colors hover:bg-surface hover:text-accent"
					>
						<Icon name="table" size={15} class="flex-shrink-0 text-muted" />
						<span class="truncate">{collection.title || 'Untitled'}</span>
						<span class="ml-auto text-xs text-muted">{collection.schema.length} fields</span>
					</a>
				{:else}
					<p class="py-4 text-center text-sm text-muted italic">No collections created yet.</p>
				{/each}
			</div>

			<form method="POST" action="?/createCollection" class="mt-4 flex gap-2">
				<input
					type="text"
					name="title"
					placeholder="New collection title…"
					required
					class="flex-1 rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
				/>
				<button
					type="submit"
					class="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition-opacity hover:opacity-90"
				>
					<Icon name="plus" size={14} />
					<span>Create</span>
				</button>
			</form>
		</section>
	</div>
</div>
