<script lang="ts">
	import { tick } from 'svelte';
	import type { LinkComposer } from '$lib/client/link-composer.svelte';
	import type { CollectionMeta, DocumentMeta } from '$lib/data/types';

	let {
		composer,
		documents,
		collections,
		currentDocumentId,
		documentLocation,
		onApply
	}: {
		composer: LinkComposer;
		documents: DocumentMeta[];
		collections: CollectionMeta[];
		currentDocumentId: string;
		documentLocation: (documentId: string) => string;
		onApply: () => void;
	} = $props();

	let linkUrlInput: HTMLInputElement | undefined = $state();
	let dialog: HTMLDivElement | undefined = $state();

	$effect(() => {
		if (!composer.blockId || composer.mode !== 'url') return;
		void tick().then(() => linkUrlInput?.focus());
	});
</script>

{#if composer.blockId !== null}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
		role="presentation"
	>
		<div
			bind:this={dialog}
			role="dialog"
			aria-modal="true"
			aria-labelledby="link-composer-title"
			tabindex="-1"
			class="w-full max-w-md rounded-lg border border-border bg-bg p-5 shadow-xl"
			onkeydown={(event) => composer.handleKeydown(event, dialog)}
		>
			<h2 id="link-composer-title" class="text-lg font-semibold text-fg">Add link</h2>
			<div class="mt-4 flex gap-2" role="group" aria-label="Link type">
				<button
					type="button"
					onclick={() => (composer.mode = 'url')}
					class="rounded px-3 py-1.5 text-sm"
					class:bg-accent={composer.mode === 'url'}
					class:text-accent-fg={composer.mode === 'url'}
					class:bg-surface={composer.mode !== 'url'}>Web address</button
				>
				<button
					type="button"
					onclick={() => (composer.mode = 'record')}
					class="rounded px-3 py-1.5 text-sm"
					class:bg-accent={composer.mode === 'record'}
					class:text-accent-fg={composer.mode === 'record'}
					class:bg-surface={composer.mode !== 'record'}>Workspace item</button
				>
			</div>
			{#if composer.mode === 'url'}
				<label class="mt-4 block text-sm font-medium text-fg">
					Web address
					<input
						bind:this={linkUrlInput}
						bind:value={composer.url}
						placeholder="https://example.com"
						class="mt-1.5 w-full rounded border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent"
					/>
				</label>
			{:else}
				<label class="mt-4 block text-sm font-medium text-fg">
					Link to
					<select
						bind:value={composer.recordId}
						class="mt-1.5 w-full rounded border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent"
					>
						<option value="">Choose a page or collection…</option>
						<optgroup label="Pages">
							{#each documents as document (document.id)}
								{#if document.id !== currentDocumentId}
									<option value={document.id}>{documentLocation(document.id)}</option>
								{/if}
							{/each}
						</optgroup>
						<optgroup label="Collections">
							{#each collections as collection (collection.id)}
								<option value={collection.id}>{collection.title || 'Untitled collection'}</option>
							{/each}
						</optgroup>
					</select>
				</label>
			{/if}
			<div class="mt-5 flex justify-end gap-2">
				<button
					type="button"
					onclick={() => composer.close()}
					class="rounded px-3 py-2 text-sm text-muted hover:text-fg">Cancel</button
				>
				<button
					type="button"
					disabled={composer.mode === 'url' ? !composer.url.trim() : !composer.recordId}
					onclick={onApply}
					class="rounded bg-accent px-3 py-2 text-sm font-medium text-accent-fg disabled:opacity-40"
					>Add link</button
				>
			</div>
		</div>
	</div>
{/if}
