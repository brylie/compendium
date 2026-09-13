<script lang="ts">
	import { resolve } from '$app/paths';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let mirrorEnabled = $state(false);
	let outputDir = $state('');

	$effect(() => {
		mirrorEnabled = data.mirrorConfig.enabled;
		outputDir = data.mirrorConfig.outputDir;
	});
</script>

<svelte:head>
	<title>Workspace Export & Backup — Compendium</title>
</svelte:head>

<div class="mx-auto max-w-4xl px-6 py-8">
	<div class="mb-8">
		<h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100">Workspace Export & Backup</h1>
		<p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
			Export your workspace data to standard Markdown and structured JSON/CSV files, or configure a
			live Markdown mirror on disk.
		</p>
	</div>

	{#if form?.error}
		<div class="mb-6 rounded-md bg-red-50 p-4 dark:bg-red-950/40">
			<p class="text-sm font-medium text-red-800 dark:text-red-200">{form.error}</p>
		</div>
	{/if}

	{#if form?.success}
		<div class="mb-6 rounded-md bg-emerald-50 p-4 dark:bg-emerald-950/40">
			<p class="text-sm font-medium text-emerald-800 dark:text-emerald-200">
				Settings updated successfully!
			</p>
		</div>
	{/if}

	<div class="space-y-8">
		<!-- Manual Workspace Export Section -->
		<section
			class="rounded-xl border border-slate-200 bg-white p-6 shadow-xs dark:border-slate-800 dark:bg-slate-900"
		>
			<h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">
				Download Full Workspace Export
			</h2>
			<p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
				Obtain a full archive containing all Documents formatted as CommonMark Markdown files,
				Collections serialized as JSON and CSV, and a top-level <code
					class="rounded bg-slate-100 px-1 py-0.5 text-xs text-slate-800 dark:bg-slate-800 dark:text-slate-200"
					>manifest.json</code
				>.
			</p>
			<div class="mt-6">
				<a
					href={resolve('/api/export?scope=workspace')}
					download
					class="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-xs hover:bg-indigo-500 focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:outline-hidden dark:bg-indigo-500 dark:hover:bg-indigo-400"
				>
					Download Workspace ZIP
				</a>
			</div>
		</section>

		<!-- Periodic Markdown Mirror Section -->
		<section
			class="rounded-xl border border-slate-200 bg-white p-6 shadow-xs dark:border-slate-800 dark:bg-slate-900"
		>
			<h2 class="text-lg font-semibold text-slate-900 dark:text-slate-100">
				Periodic Markdown Mirror on Disk
			</h2>
			<p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
				Automatically maintain a fresh, human-readable, disposable Markdown mirror of your workspace
				on disk for local tools (<code
					class="rounded bg-slate-100 px-1 py-0.5 text-xs text-slate-800 dark:bg-slate-800 dark:text-slate-200"
					>ripgrep</code
				>, Obsidian, filesystem search).
			</p>

			<form method="POST" action="?/updateMirror" class="mt-6 space-y-6">
				<div class="flex items-center justify-between">
					<div>
						<label for="enabled" class="text-sm font-medium text-slate-900 dark:text-slate-100">
							Enable Markdown Mirror
						</label>
						<p class="text-xs text-slate-500 dark:text-slate-400">
							When enabled, Compendium periodically updates a directory of Markdown files on disk.
						</p>
					</div>
					<input
						type="checkbox"
						id="enabled"
						name="enabled"
						bind:checked={mirrorEnabled}
						class="h-5 w-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-700 dark:bg-slate-800"
					/>
				</div>

				<div>
					<label
						for="outputDir"
						class="block text-sm font-medium text-slate-900 dark:text-slate-100"
					>
						Output Directory Path
					</label>
					<input
						type="text"
						id="outputDir"
						name="outputDir"
						bind:value={outputDir}
						placeholder=".data/markdown-mirror"
						class="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-xs focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-hidden dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100"
					/>
					<p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
						Relative to workspace root or an absolute filesystem path.
					</p>
				</div>

				<div class="flex items-center space-x-4">
					<button
						type="submit"
						class="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-xs hover:bg-slate-800 focus:ring-2 focus:ring-slate-900 focus:ring-offset-2 focus:outline-hidden dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
					>
						Save Settings
					</button>

					{#if mirrorEnabled}
						<button
							type="submit"
							formaction="?/syncNow"
							class="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-xs hover:bg-slate-50 focus:ring-2 focus:ring-slate-500 focus:ring-offset-2 focus:outline-hidden dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
						>
							Sync Now
						</button>
					{/if}
				</div>
			</form>
		</section>
	</div>
</div>
