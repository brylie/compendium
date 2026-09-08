<script lang="ts">
	import type * as Y from 'yjs';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { resolveCollectionDoc } from '$lib/client/yjs-client';
	import { useCollectionView } from '$lib/client/collection-view.svelte';
	import { resolvePrimaryField } from '$lib/data/collection-ops';
	import { listRelationBacklinks, primaryFieldDisplayValue } from '$lib/data/views';
	import type { CollectionMeta, WorkspaceRecord } from '$lib/data/types';

	// One Collection candidate for RecordDetailPane's cross-Collection
	// backlinks (collection-views.md §11): a Collection whose schema already
	// has a `relation` field targeting the pane's own Collection, resolved
	// only on demand — connecting to its shard the same way
	// RelationPropertyCell.svelte does for a forward relation value, since
	// there's no workspace-wide reverse-relation index to read instead
	// (issue #154's collection-views.md addendum documents this as the
	// deliberate scope).
	let {
		collection,
		targetRecordId
	}: {
		collection: CollectionMeta;
		targetRecordId: string;
	} = $props();

	let doc: Y.Doc | undefined = $state();
	// Tracks which collectionId `doc` actually belongs to — gates the
	// useCollectionView read below so a still-connecting or just-retargeted
	// instance never reads the *previous* collection's live snapshot under
	// the *new* collection.id key (the same `resolvedFor` guard
	// RelationPropertyCell.svelte uses for its own forward-relation resolve).
	let resolvedFor: string | undefined = $state();
	let resolveFailed = $state(false);

	$effect(() => {
		const collectionId = collection.id;
		resolveFailed = false;
		doc = undefined;
		resolvedFor = undefined;
		resolveCollectionDoc(collectionId)
			.then((resolved) => {
				if (collection.id !== collectionId) return;
				doc = resolved;
				resolvedFor = collectionId;
			})
			.catch(() => {
				if (collection.id !== collectionId) return;
				resolveFailed = true;
			});
	});

	const view = useCollectionView(
		() => (resolvedFor === collection.id ? doc : undefined),
		() => collection.id
	);
	const titleProperty = $derived(resolvePrimaryField(view.schema, view.primaryFieldKey));
	// useCollectionView retains its last-read snapshot when its own getDoc
	// returns undefined (by design, for a caller that wants to freeze rather
	// than reset — see its own doc comment), so the resolvedFor gate above
	// only stops a *fresh* read; view.rows/view.schema can still be the
	// *previous* collection's data for one tick after collection.id changes.
	// Re-checking view.collection?.id here (not just resolvedFor) is what
	// keeps a mid-retarget render from pairing a stale snapshot's backlinks
	// with this component's already-updated collection.title/id in the
	// markup below.
	const backlinks = $derived(
		resolvedFor === collection.id && view.collection?.id === collection.id
			? listRelationBacklinks(view.rows, view.schema, targetRecordId)
			: []
	);

	function titleFor(record: WorkspaceRecord): string {
		return (
			primaryFieldDisplayValue(
				titleProperty ? record.properties?.[titleProperty.key] : undefined,
				titleProperty
			) || 'Untitled'
		);
	}
</script>

{#if resolveFailed}
	<li class="px-2 py-1 text-xs text-red-500 italic">
		Couldn't load {collection.title || 'Untitled collection'}
	</li>
{:else}
	{#each backlinks as backlink (backlink.record.id + ':' + backlink.property.key)}
		<li>
			<a
				href={resolve('/space/[spaceId]/table/[id]', {
					spaceId: page.params.spaceId!,
					id: collection.id
				})}
				class="flex items-center justify-between gap-2 rounded px-2 py-1 text-xs text-fg hover:bg-surface hover:text-accent"
			>
				<span class="truncate">{titleFor(backlink.record)}</span>
				<span class="flex-shrink-0 text-muted"
					>{collection.title || 'Untitled'} · {backlink.property.label}</span
				>
			</a>
		</li>
	{/each}
{/if}
