<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatActor, formatTimestamp } from '$lib/data/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Audit log · AgentSpace</title>
</svelte:head>

<main>
	<a class="back" href={resolve('/')}>← Workspace</a>
	<h1>Audit log</h1>

	<form method="GET" class="filter">
		<label>
			Actor kind
			<select
				name="actorKind"
				value={data.actorKind}
				onchange={(e) => e.currentTarget.form?.submit()}
			>
				<option value="">All</option>
				<option value="human">Human</option>
				<option value="human-via-client">Human via client</option>
				<option value="agent">Agent</option>
			</select>
		</label>
	</form>

	<table>
		<thead>
			<tr>
				<th>Time</th>
				<th>Actor</th>
				<th>Action</th>
				<th>Target</th>
			</tr>
		</thead>
		<tbody>
			{#each data.entries as entry (entry.id)}
				<tr>
					<td>{formatTimestamp(entry.timestamp)}</td>
					<td>{formatActor(entry.actor)}</td>
					<td>{entry.action}</td>
					<td class="target">{entry.targetRecordId ?? '—'}</td>
				</tr>
			{:else}
				<tr><td colspan="4" class="empty">No audit entries yet.</td></tr>
			{/each}
		</tbody>
	</table>
</main>

<style>
	main {
		max-width: 50rem;
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
	.filter {
		margin-bottom: 1rem;
	}
	table {
		border-collapse: collapse;
		width: 100%;
	}
	th,
	td {
		border: 1px solid #e5e5e5;
		padding: 0.4rem 0.6rem;
		text-align: left;
		font-size: 0.85rem;
	}
	.target {
		font-family: ui-monospace, monospace;
		font-size: 0.75rem;
	}
	.empty {
		color: #999;
	}
</style>
