<script lang="ts">
	import { resolve } from '$app/paths';
	import type { Backlink } from '$lib/data/links';
	import Icon from './Icon.svelte';

	// Issue #83: navigates to the exact referring block, not just the
	// referring Document. `onJumpTo` mirrors SyncedBlockUsage.svelte's own
	// same-document short-circuit — a link whose sourceDocumentId is the
	// Document already open gets an in-place scroll/focus/highlight via the
	// page's navigateToBlock instead of a full navigation (which would be a
	// no-op page reload landing on the same #block-<id> hash regardless, just
	// slower and losing in-progress state elsewhere on the page). A
	// cross-document link is left as a real <a href>, so browser Back and
	// keyboard Enter/Space activation both keep working for free.
	let {
		spaceId,
		currentDocumentId,
		backlinks,
		onJumpTo
	}: {
		spaceId: string;
		currentDocumentId: string;
		backlinks: Backlink[];
		onJumpTo: (documentId: string, recordId: string) => void;
	} = $props();
</script>

<section
	class="mt-5 rounded-lg border border-border bg-surface/50 p-3"
	aria-labelledby="backlinks-heading"
>
	<div class="flex items-center gap-2 text-xs font-semibold tracking-wider text-muted uppercase">
		<Icon name="link" size={15} class="text-accent" />
		<h2 id="backlinks-heading">Backlinks</h2>
		<span class="normal-case">{backlinks.length}</span>
	</div>
	{#if backlinks.length > 0}
		<ul class="mt-2 space-y-2">
			{#each backlinks as backlink, index (`${backlink.sourceRecordId}-${index}`)}
				<li class="min-w-0 text-sm">
					<a
						href="{resolve('/space/[spaceId]/doc/[id]', {
							spaceId,
							id: backlink.sourceDocumentId
						})}#block-{backlink.sourceRecordId}"
						onclick={(e) => {
							if (backlink.sourceDocumentId === currentDocumentId) {
								e.preventDefault();
								onJumpTo(backlink.sourceDocumentId, backlink.sourceRecordId);
							}
						}}
						class="font-medium text-fg underline underline-offset-2 transition-colors hover:text-accent"
					>
						{backlink.sourceDocumentTitle || 'Untitled Document'}
					</a>
					<p class="mt-0.5 truncate text-xs text-muted" title={backlink.context}>
						{backlink.context}
					</p>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="mt-2 text-xs text-muted italic">No pages link here yet.</p>
	{/if}
</section>
