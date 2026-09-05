<script lang="ts">
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { resolve } from '$app/paths';
	import { formatTimestamp } from '$lib/data/format';
	import { buildDocumentTree } from '$lib/data/document-ops';
	import type { DocumentMeta, DocumentTreeNode } from '$lib/data/types';
	import Icon from '$lib/components/Icon.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// The flat "Allowed Documents" checkbox list gave no way to tell apart two
	// same-titled Documents, or even two Documents from different Spaces
	// entirely (issue #78) — this allowlist spans every Space in the workspace,
	// so a plain title is genuinely ambiguous here in a way it isn't in the
	// sidebar (which already shows a Document in its real tree position). Fixed
	// by rendering the actual page tree, grouped by Space, instead of a bare
	// list — the surrounding structure is the disambiguating context, not a
	// synthesized label.
	let documentsBySpaceId = $derived.by(() => {
		const groups = new SvelteMap<string, DocumentMeta[]>();
		for (const document of data.documents) {
			const key = document.spaceId ?? '';
			const list = groups.get(key);
			if (list) list.push(document);
			else groups.set(key, [document]);
		}
		return groups;
	});
	let uncatalogedDocuments = $derived(documentsBySpaceId.get('') ?? []);

	let expandedDocIds = new SvelteSet<string>();
	let checkedDocumentIds = new SvelteSet<string>();

	function toggleExpanded(id: string): void {
		if (expandedDocIds.has(id)) expandedDocIds.delete(id);
		else expandedDocIds.add(id);
	}

	function checkDocument(id: string): void {
		checkedDocumentIds.add(id);
	}

	function uncheckDocument(id: string): void {
		checkedDocumentIds.delete(id);
	}

	/** Checks `node` and every one of its current descendants — an explicit, visible convenience for granting a whole subtree, not an implicit "parent covers children" permission rule (the token's actual grant stays the plain, exact-id list it always was). */
	function selectSubtree(node: DocumentTreeNode): void {
		checkedDocumentIds.add(node.id);
		for (const child of node.children) selectSubtree(child);
	}
</script>

<svelte:head>
	<title>Access Tokens · Compendium</title>
</svelte:head>

<div class="mx-auto max-w-4xl px-6 py-10">
	<nav class="mb-4 flex items-center gap-1.5 text-xs text-muted">
		<a href={resolve('/')} class="flex items-center gap-1 transition-colors hover:text-accent">
			<span>Workspace</span>
		</a>
		<span>/</span>
		<a href={resolve('/settings/tokens')} class="hover:text-accent">Settings</a>
		<span>/</span>
		<span class="font-medium text-fg">Access Tokens</span>
	</nav>

	<header class="mb-6">
		<h1 class="font-display text-3xl font-semibold tracking-tight text-fg">Access Tokens</h1>
		<p class="mt-1 text-sm text-muted">
			Bearer tokens for MCP clients (Claude Desktop, Claude Code, ChatGPT) connecting to <code
				>/mcp</code
			>.
		</p>
	</header>

	{#if form?.createdToken}
		<div
			class="mb-6 rounded-lg border border-amber-300 bg-amber-50/80 p-4 text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-200"
		>
			<div class="flex items-center gap-2 font-medium">
				<Icon name="key" size={16} />
				<span>Token created for "{form.clientLabel}" — copy it now; it won't be shown again:</span>
			</div>
			<code
				class="mt-2 block overflow-x-auto rounded border border-border bg-bg p-2.5 font-mono text-xs text-fg"
			>
				{form.createdToken}
			</code>
		</div>
	{/if}

	<div class="mb-10 overflow-x-auto rounded-lg border border-border bg-bg shadow-xs">
		<table class="w-full border-collapse text-left text-sm">
			<thead>
				<tr
					class="border-b border-border bg-surface text-xs font-semibold tracking-wider text-muted"
				>
					<th class="px-3.5 py-2.5">Client</th>
					<th class="px-3.5 py-2.5">Scope</th>
					<th class="px-3.5 py-2.5">Created</th>
					<th class="px-3.5 py-2.5">Status</th>
					<th class="px-3.5 py-2.5"></th>
				</tr>
			</thead>
			<tbody class="divide-y divide-border">
				{#each data.tokens as token (token.tokenHash)}
					<tr class="transition-colors hover:bg-surface/30">
						<td class="px-3.5 py-2.5 font-medium text-fg">{token.clientLabel}</td>
						<td class="px-3.5 py-2.5 text-xs text-muted">
							{token.allowedDocumentIds.length} doc(s), {token.allowedCollectionIds.length} collection(s){#if token.allowedSpaceIds.length},
								{token.allowedSpaceIds.length} space(s){/if}
						</td>
						<td class="px-3.5 py-2.5 text-xs text-muted">{formatTimestamp(token.createdAt)}</td>
						<td class="px-3.5 py-2.5">
							{#if token.revokedAt}
								<span
									class="rounded bg-red-100 px-1.5 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950/50 dark:text-red-300"
								>
									Revoked
								</span>
							{:else}
								<span
									class="rounded bg-green-100 px-1.5 py-0.5 text-xs font-medium text-green-700 dark:bg-green-950/50 dark:text-green-300"
								>
									Active
								</span>
							{/if}
						</td>
						<td class="px-3.5 py-2.5 text-right">
							{#if !token.revokedAt}
								<form method="POST" action="?/revoke" class="inline">
									<input type="hidden" name="tokenHash" value={token.tokenHash} />
									<button
										type="submit"
										class="text-xs font-medium text-red-600 hover:underline dark:text-red-400"
									>
										Revoke
									</button>
								</form>
							{/if}
						</td>
					</tr>
				{:else}
					<tr>
						<td colspan="5" class="py-8 text-center text-sm text-muted italic">
							No access tokens created yet.
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<!-- Connect Client Form -->
	<section class="rounded-lg border border-border bg-surface/50 p-6">
		<h2 class="font-display text-lg font-semibold text-fg">Connect a Client</h2>
		<form method="POST" action="?/create" class="mt-4 space-y-4">
			<div>
				<label for="clientLabel" class="block text-xs font-medium text-muted uppercase"
					>Client Label</label
				>
				<input
					type="text"
					id="clientLabel"
					name="clientLabel"
					placeholder="e.g. Claude Desktop, Cursor, Custom Agent"
					required
					class="mt-1 w-full max-w-md rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none"
				/>
			</div>

			<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
				<fieldset class="rounded-md border border-border bg-bg/50 p-3">
					<legend class="px-1 text-xs font-semibold text-muted uppercase">Allowed Spaces</legend>
					<div class="mt-2 max-h-40 space-y-1.5 overflow-y-auto">
						{#each data.spaces as space (space.id)}
							<label
								class="flex cursor-pointer items-center gap-2 text-sm text-fg hover:text-accent"
							>
								<input
									type="checkbox"
									name="spaceIds"
									value={space.id}
									class="rounded border-border text-accent focus:ring-accent"
								/>
								<span class="truncate">{space.name}</span>
							</label>
						{:else}
							<p class="text-xs text-muted italic">No spaces available.</p>
						{/each}
					</div>
				</fieldset>

				<fieldset class="rounded-md border border-border bg-bg/50 p-3">
					<legend class="px-1 text-xs font-semibold text-muted uppercase">Allowed Documents</legend>
					<div class="mt-2 max-h-56 space-y-0.5 overflow-y-auto">
						{#snippet renderDocumentNode(node: DocumentTreeNode)}
							{@const hasChildren = node.children.length > 0}
							{@const isExpanded = expandedDocIds.has(node.id)}
							<div
								class="group/doc flex items-center gap-1"
								style="padding-left: {node.level * 14}px;"
							>
								{#if hasChildren}
									<button
										type="button"
										onclick={() => toggleExpanded(node.id)}
										class="p-0.5 text-muted hover:text-fg"
										aria-label={isExpanded ? 'Collapse sub-pages' : 'Expand sub-pages'}
									>
										<Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size={12} />
									</button>
								{:else}
									<span class="w-[18px]"></span>
								{/if}
								<label
									class="flex flex-1 cursor-pointer items-center gap-2 truncate py-0.5 text-sm text-fg hover:text-accent"
								>
									<input
										type="checkbox"
										value={node.id}
										checked={checkedDocumentIds.has(node.id)}
										onchange={(e) =>
											e.currentTarget.checked ? checkDocument(node.id) : uncheckDocument(node.id)}
										class="rounded border-border text-accent focus:ring-accent"
									/>
									<span class="truncate">{node.title || 'Untitled'}</span>
								</label>
								{#if hasChildren}
									<button
										type="button"
										onclick={() => selectSubtree(node)}
										class="p-0.5 text-muted opacity-0 group-hover/doc:opacity-100 hover:text-accent focus-visible:opacity-100"
										title="Select this page and its sub-pages"
										aria-label="Select this page and its sub-pages"
									>
										<Icon name="child-pages" size={12} />
									</button>
								{/if}
							</div>
							{#if hasChildren && isExpanded}
								{#each node.children as child (child.id)}
									{@render renderDocumentNode(child)}
								{/each}
							{/if}
						{/snippet}

						{#each data.spaces as space (space.id)}
							{@const spaceDocs = documentsBySpaceId.get(space.id) ?? []}
							{#if spaceDocs.length > 0}
								<div
									class="mt-2 px-0.5 text-[10px] font-semibold tracking-wide text-muted uppercase first:mt-0"
								>
									{space.name}
								</div>
								{#each buildDocumentTree(spaceDocs) as root (root.id)}
									{@render renderDocumentNode(root)}
								{/each}
							{/if}
						{/each}

						{#if uncatalogedDocuments.length > 0}
							<div
								class="mt-2 px-0.5 text-[10px] font-semibold tracking-wide text-muted uppercase first:mt-0"
							>
								Uncataloged
							</div>
							{#each buildDocumentTree(uncatalogedDocuments) as root (root.id)}
								{@render renderDocumentNode(root)}
							{/each}
						{/if}

						{#if data.documents.length === 0}
							<p class="text-xs text-muted italic">No documents available.</p>
						{/if}
					</div>
					<!-- Submitted independently of the tree's expand/collapse state — a
					     checkbox for a collapsed descendant checked via "select subtree"
					     below has no rendered <input> of its own to submit. -->
					{#each [...checkedDocumentIds] as id (id)}
						<input type="hidden" name="documentIds" value={id} />
					{/each}
				</fieldset>

				<fieldset class="rounded-md border border-border bg-bg/50 p-3">
					<legend class="px-1 text-xs font-semibold text-muted uppercase"
						>Allowed Collections</legend
					>
					<div class="mt-2 max-h-56 space-y-1.5 overflow-y-auto">
						{#each data.collections as collection (collection.id)}
							<label
								class="flex cursor-pointer items-center gap-2 text-sm text-fg hover:text-accent"
							>
								<input
									type="checkbox"
									name="collectionIds"
									value={collection.id}
									class="rounded border-border text-accent focus:ring-accent"
								/>
								<span class="truncate">{collection.title || 'Untitled'}</span>
							</label>
						{:else}
							<p class="text-xs text-muted italic">No collections available.</p>
						{/each}
					</div>
				</fieldset>
			</div>

			<button
				type="submit"
				class="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition-opacity hover:opacity-90"
			>
				<Icon name="key" size={15} />
				<span>Create Token</span>
			</button>
		</form>
	</section>
</div>
