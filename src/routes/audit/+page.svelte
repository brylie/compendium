<script lang="ts">
	import { resolve } from '$app/paths';
	import { formatActor, formatTimestamp } from '$lib/data/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Audit Log · Compendium</title>
</svelte:head>

<div class="mx-auto max-w-4xl px-6 py-10">
	<nav class="mb-4 flex items-center gap-1.5 text-xs text-muted">
		<a href={resolve('/')} class="flex items-center gap-1 transition-colors hover:text-accent">
			<span>Workspace</span>
		</a>
		<span>/</span>
		<span class="font-medium text-fg">Audit Log</span>
	</nav>

	<header class="mb-6 flex items-center justify-between">
		<div>
			<h1 class="font-display text-3xl font-semibold tracking-tight text-fg">Audit Log</h1>
			<p class="mt-1 text-sm text-muted">
				{data.targetRecordId
					? `Audit history for block ${data.targetRecordId}.`
					: 'Chronological trail of human and agent operations.'}
			</p>
		</div>

		<form method="GET" class="flex items-center gap-2">
			{#if data.targetRecordId}
				<input type="hidden" name="targetRecordId" value={data.targetRecordId} />
			{/if}
			<label class="flex items-center gap-1.5 text-xs text-muted">
				<span>Filter:</span>
				<select
					name="actorKind"
					value={data.actorKind}
					onchange={(e) => e.currentTarget.form?.submit()}
					class="rounded-md border border-border bg-surface px-2.5 py-1 text-xs text-fg focus:border-accent focus:outline-none"
				>
					<option value="">All actors</option>
					<option value="human">Human</option>
					<option value="human-via-client">Human via client</option>
					<option value="agent">Agent</option>
				</select>
			</label>
			{#if data.targetRecordId}
				<a href={resolve('/audit')} class="text-xs text-muted transition-colors hover:text-accent">
					All history
				</a>
			{/if}
		</form>
	</header>

	<div class="overflow-x-auto rounded-lg border border-border bg-bg shadow-xs">
		<table class="w-full border-collapse text-left text-sm">
			<thead>
				<tr
					class="border-b border-border bg-surface text-xs font-semibold tracking-wider text-muted"
				>
					<th class="px-3.5 py-2.5">Time</th>
					<th class="px-3.5 py-2.5">Actor</th>
					<th class="px-3.5 py-2.5">Action</th>
					<th class="px-3.5 py-2.5">Target</th>
				</tr>
			</thead>
			<tbody class="divide-y divide-border">
				{#each data.entries as entry (entry.id)}
					<tr class="transition-colors hover:bg-surface/30">
						<td class="px-3.5 py-2 text-xs whitespace-nowrap text-muted">
							{formatTimestamp(entry.timestamp)}
						</td>
						<td class="px-3.5 py-2 text-sm font-medium text-fg">
							{formatActor(entry.actor)}
						</td>
						<td class="px-3.5 py-2">
							<span
								class="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-xs text-accent"
							>
								{entry.action}
							</span>
						</td>
						<td class="px-3.5 py-2 font-mono text-xs text-muted">
							{entry.targetRecordId ?? '—'}
						</td>
					</tr>
				{:else}
					<tr>
						<td colspan="4" class="py-8 text-center text-sm text-muted italic">
							No audit entries matching filter.
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>
