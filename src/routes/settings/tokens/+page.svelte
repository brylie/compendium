<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatTimestamp } from '$lib/data/format';
	import Icon from '$lib/components/Icon.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
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
							{token.allowedDocumentIds.length} doc(s), {token.allowedCollectionIds.length} collection(s)
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

			<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
				<fieldset class="rounded-md border border-border bg-bg/50 p-3">
					<legend class="px-1 text-xs font-semibold text-muted uppercase">Allowed Documents</legend>
					<div class="mt-2 max-h-40 space-y-1.5 overflow-y-auto">
						{#each data.documents as document (document.id)}
							<label
								class="flex cursor-pointer items-center gap-2 text-sm text-fg hover:text-accent"
							>
								<input
									type="checkbox"
									name="documentIds"
									value={document.id}
									class="rounded border-border text-accent focus:ring-accent"
								/>
								<span class="truncate">{document.title || 'Untitled'}</span>
							</label>
						{:else}
							<p class="text-xs text-muted italic">No documents available.</p>
						{/each}
					</div>
				</fieldset>

				<fieldset class="rounded-md border border-border bg-bg/50 p-3">
					<legend class="px-1 text-xs font-semibold text-muted uppercase"
						>Allowed Collections</legend
					>
					<div class="mt-2 max-h-40 space-y-1.5 overflow-y-auto">
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
