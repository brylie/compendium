<script lang="ts">
	import type { WorkspaceRecord } from '$lib/data/types';
	import Icon from './Icon.svelte';

	// Bookmark / Smart Link block (issue #155) — renders a rich preview card
	// (favicon/title/description/thumbnail) once the server-side fetch
	// resolves, but always wraps it in one real `<a href>` so the block stays
	// a genuine, keyboard/screen-reader-navigable link regardless of preview
	// status (block-capability-contract.md field 11) — the "always retains an
	// accessible plain link as a fallback" requirement is satisfied by that
	// link existing at all, not by a separate fallback-only render path.
	//
	// CRDT writes are the caller's responsibility (onSubmitUrl/onRetry) rather
	// than this component importing record-ops.ts directly — url submission
	// converts an in-place block on the paste-URL path too
	// (+page.svelte#handlePasteUrl), so the parent already owns that
	// transaction; keeping both paths through the same two callbacks avoids
	// this component needing to know which case it's in.
	let {
		block,
		onSubmitUrl,
		onRetry
	}: {
		block: WorkspaceRecord;
		onSubmitUrl: (url: string) => void;
		onRetry: () => void;
	} = $props();

	let draftUrl = $state('');
	let inputError = $state('');

	// Accepts a bare "example.com" the same way a browser address bar would,
	// not just a fully-qualified "https://example.com" — pasting a URL
	// usually already includes the scheme, but typing one by hand often
	// doesn't.
	function normalizeUrl(value: string): string | null {
		const trimmed = value.trim();
		if (!trimmed) return null;
		const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
		try {
			const parsed = new URL(withScheme);
			return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
		} catch {
			return null;
		}
	}

	function handleSubmit(event: SubmitEvent): void {
		event.preventDefault();
		const normalized = normalizeUrl(draftUrl);
		if (!normalized) {
			inputError = 'Enter a valid web address.';
			return;
		}
		inputError = '';
		onSubmitUrl(normalized);
	}

	function hideBrokenImage(event: Event): void {
		(event.currentTarget as HTMLImageElement).style.display = 'none';
	}

	const metadata = $derived(block.bookmarkMetadata);
	const status = $derived(metadata?.status);
	// `??` alone would not fall through on an empty/whitespace-only fetched
	// title (only on null/undefined) — the explicit length check is what makes
	// an empty scraped title fall back to the plain url instead of rendering
	// blank.
	const title = $derived.by(() => {
		const trimmed = metadata?.title?.trim();
		if (trimmed && trimmed.length > 0) return trimmed;
		return block.url;
	});
	const hostname = $derived.by(() => {
		if (!block.url) return '';
		try {
			return new URL(block.url).hostname;
		} catch {
			return block.url;
		}
	});
</script>

{#if !block.url}
	<form
		onsubmit={handleSubmit}
		class="my-1 flex items-center gap-2 rounded-lg border border-border bg-surface/50 p-2.5 shadow-xs"
	>
		<Icon name="bookmark" size={16} class="flex-shrink-0 text-accent" />
		<input
			type="text"
			bind:value={draftUrl}
			placeholder="Paste or type a URL…"
			aria-label="Bookmark URL"
			class="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-sm text-fg outline-none focus:border-accent"
		/>
		<button
			type="submit"
			class="flex-shrink-0 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg hover:opacity-90"
		>
			Add bookmark
		</button>
	</form>
	{#if inputError}
		<p class="mt-1 text-xs text-red-600" role="alert">{inputError}</p>
	{/if}
{:else}
	<div class="my-1 overflow-hidden rounded-lg border border-border bg-surface/50 shadow-xs">
		<a
			href={block.url}
			target="_blank"
			rel="external noopener noreferrer nofollow"
			class="flex items-start gap-3 p-2.5 transition-colors hover:bg-surface"
		>
			{#if status === 'ready' && metadata?.faviconUrl}
				<img
					src={metadata.faviconUrl}
					alt=""
					class="mt-0.5 h-4 w-4 flex-shrink-0 rounded-sm"
					onerror={hideBrokenImage}
				/>
			{:else}
				<Icon name="bookmark" size={16} class="mt-0.5 flex-shrink-0 text-accent" />
			{/if}
			<div class="min-w-0 flex-1">
				<div class="truncate text-sm font-medium text-fg">
					{title}
				</div>
				{#if status === 'ready' && metadata?.description}
					<p class="mt-0.5 line-clamp-2 text-xs text-muted">{metadata.description}</p>
				{/if}
				<div class="mt-1 flex items-center gap-1.5 text-[11px] text-muted">
					{#if status === 'pending'}
						<span>Fetching preview…</span>
					{:else if status === 'error'}
						<span>Couldn't load a preview.</span>
					{/if}
					<span class="truncate">{hostname}</span>
				</div>
			</div>
			{#if status === 'ready' && metadata?.thumbnailUrl}
				<img
					src={metadata.thumbnailUrl}
					alt=""
					class="h-14 w-20 flex-shrink-0 rounded object-cover"
					onerror={hideBrokenImage}
				/>
			{/if}
		</a>
		{#if status === 'error'}
			<div class="border-t border-border px-2.5 py-1.5">
				<button type="button" onclick={onRetry} class="text-xs text-accent hover:underline">
					Retry preview
				</button>
			</div>
		{/if}
	</div>
{/if}
