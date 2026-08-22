<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatTimestamp } from '$lib/data/format';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>Tokens · AgentSpace</title>
</svelte:head>

<main>
	<a class="back" href={resolve('/')}>← Workspace</a>
	<h1>Access tokens</h1>
	<p class="hint">
		Local tokens stand in for per-user OAuth in Phase 0 — point Claude Desktop, Claude Code, or
		ChatGPT's MCP config at <code>/mcp</code> with one of these as a bearer token.
	</p>

	{#if form?.createdToken}
		<div class="created">
			<strong>Token created for "{form.clientLabel}" — copy it now, it won't be shown again:</strong
			>
			<code>{form.createdToken}</code>
		</div>
	{/if}

	<table>
		<thead>
			<tr>
				<th>Client</th>
				<th>Scope</th>
				<th>Created</th>
				<th>Status</th>
				<th></th>
			</tr>
		</thead>
		<tbody>
			{#each data.tokens as token (token.tokenHash)}
				<tr>
					<td>{token.clientLabel}</td>
					<td
						>{token.allowedDocumentIds.length} doc(s), {token.allowedCollectionIds.length} collection(s)</td
					>
					<td>{formatTimestamp(token.createdAt)}</td>
					<td>{token.revokedAt ? `Revoked ${formatTimestamp(token.revokedAt)}` : 'Active'}</td>
					<td>
						{#if !token.revokedAt}
							<form method="POST" action="?/revoke">
								<input type="hidden" name="tokenHash" value={token.tokenHash} />
								<button type="submit">Revoke</button>
							</form>
						{/if}
					</td>
				</tr>
			{:else}
				<tr><td colspan="5" class="empty">No tokens yet.</td></tr>
			{/each}
		</tbody>
	</table>

	<section class="create">
		<h2>Connect a client</h2>
		<form method="POST" action="?/create">
			<label>
				Client label
				<input type="text" name="clientLabel" placeholder="Claude Desktop" required />
			</label>

			<fieldset>
				<legend>Documents</legend>
				{#each data.documents as document (document.id)}
					<label class="checkbox">
						<input type="checkbox" name="documentIds" value={document.id} />
						{document.title}
					</label>
				{:else}
					<p class="empty">No documents yet.</p>
				{/each}
			</fieldset>

			<fieldset>
				<legend>Collections</legend>
				{#each data.collections as collection (collection.id)}
					<label class="checkbox">
						<input type="checkbox" name="collectionIds" value={collection.id} />
						{collection.title}
					</label>
				{:else}
					<p class="empty">No collections yet.</p>
				{/each}
			</fieldset>

			<button type="submit">Create token</button>
		</form>
	</section>
</main>

<style>
	main {
		max-width: 40rem;
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
	.hint {
		color: #666;
		font-size: 0.9rem;
	}
	.created {
		background: #fff8e1;
		border: 1px solid #f0d060;
		border-radius: 6px;
		padding: 0.75rem;
		margin: 1rem 0;
	}
	.created code {
		display: block;
		margin-top: 0.4rem;
		word-break: break-all;
		background: white;
		padding: 0.4rem;
		border-radius: 4px;
	}
	table {
		border-collapse: collapse;
		width: 100%;
		margin: 1rem 0;
	}
	th,
	td {
		border: 1px solid #e5e5e5;
		padding: 0.4rem 0.6rem;
		text-align: left;
		font-size: 0.9rem;
	}
	.empty {
		color: #999;
	}
	.create {
		margin-top: 2rem;
	}
	.create form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	fieldset {
		border: 1px solid #e5e5e5;
		border-radius: 6px;
	}
	.checkbox {
		display: block;
		font-weight: normal;
	}
</style>
