<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>AgentSpace</title>
</svelte:head>

<main>
	<header>
		<h1>AgentSpace</h1>
		<nav>
			<a href={resolve('/settings/tokens')}>Tokens</a>
			<a href={resolve('/audit')}>Audit log</a>
		</nav>
	</header>

	<section>
		<h2>Documents</h2>
		<ul class="list">
			{#each data.documents as document (document.id)}
				<li><a href={resolve('/doc/[id]', { id: document.id })}>{document.title}</a></li>
			{:else}
				<li class="empty">No documents yet.</li>
			{/each}
		</ul>
		<form method="POST" action="?/createDocument">
			<input type="text" name="title" placeholder="New document title" required />
			<button type="submit">Create document</button>
		</form>
	</section>

	<section>
		<h2>Collections</h2>
		<ul class="list">
			{#each data.collections as collection (collection.id)}
				<li><a href={resolve('/table/[id]', { id: collection.id })}>{collection.title}</a></li>
			{:else}
				<li class="empty">No collections yet.</li>
			{/each}
		</ul>
		<form method="POST" action="?/createCollection">
			<input type="text" name="title" placeholder="New collection title" required />
			<button type="submit">Create collection</button>
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
	header {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		margin-bottom: 2rem;
	}
	nav a {
		margin-left: 1rem;
	}
	section {
		margin-bottom: 2rem;
	}
	.list {
		list-style: none;
		padding: 0;
		margin: 0 0 0.75rem;
	}
	.list li {
		padding: 0.4rem 0;
		border-bottom: 1px solid #e5e5e5;
	}
	.empty {
		color: #888;
		border-bottom: none;
	}
	form {
		display: flex;
		gap: 0.5rem;
	}
	input {
		flex: 1;
		padding: 0.4rem;
	}
</style>
