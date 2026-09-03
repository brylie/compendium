<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { CURRENT_USER } from '$lib/client/actor';
	import {
		patchRecordViewConfig,
		setRecordReferencedId,
		setRecordViewConfig
	} from '$lib/data/records';
	import { diffViewConfig, viewConfigsEqual } from '$lib/data/views';
	import type {
		CollectionMeta,
		EmbeddedViewConfig,
		ViewType,
		WorkspaceRecord
	} from '$lib/data/types';
	import type * as Y from 'yjs';
	import Icon from './Icon.svelte';
	import TableCollectionView from './TableCollectionView.svelte';
	import BoardCollectionView from './BoardCollectionView.svelte';
	import CalendarCollectionView from './CalendarCollectionView.svelte';

	let {
		block,
		ydoc,
		collections
	}: {
		block: WorkspaceRecord;
		ydoc: Y.Doc;
		// Catalog-backed (see doc/[id]/+page.server.ts), not derived from ydoc:
		// a sharded Collection's own meta entry doesn't live in this Document's
		// doc at all (#120) — only its own shard does, which this component has
		// no connection to. Not live, same accepted tradeoff as Sidebar's list.
		collections: CollectionMeta[];
	} = $props();

	const VIEW_TYPES: { value: ViewType; label: string; icon: 'table' | 'board' | 'calendar' }[] = [
		{ value: 'table', label: 'Table', icon: 'table' },
		{ value: 'board', label: 'Board', icon: 'board' },
		{ value: 'calendar', label: 'Calendar', icon: 'calendar' }
	];

	const collection = $derived(
		block.referencedRecordId
			? collections.find((c) => c.id === block.referencedRecordId)
			: undefined
	);
	const isBroken = $derived(!!block.referencedRecordId && !collection);
	const isConfigured = $derived(!!collection && !!block.viewConfig?.viewType);

	let pickerCollectionId = $state('');
	let pickerViewType: ViewType = $state('table');
	let changing = $state(false);

	function insert(): void {
		if (!pickerCollectionId || !collections.some((c) => c.id === pickerCollectionId)) return;
		setRecordReferencedId(ydoc, block.id, pickerCollectionId, CURRENT_USER);
		setRecordViewConfig(ydoc, block.id, { viewType: pickerViewType }, CURRENT_USER);
		changing = false;
	}

	// The persisted, shared config — every collaborator connected to this
	// embed sees this the instant anyone Saves (see below).
	const persistedConfig = $derived<EmbeddedViewConfig>(
		block.viewConfig ?? { viewType: pickerViewType }
	);

	// Draft view state (issue #32): a viewer's filter/sort/grouping/visible-
	// property/summary edits stay local to this component until an explicit
	// Save promotes them to persistedConfig — mirroring the codebase's
	// existing precedent for Board's manual card order (session-local,
	// promoted only by deliberate action). Without this, ViewToolbar's
	// onConfigChange used to write straight to the shared Yjs record on
	// every keystroke, so two collaborators viewing the same embed would
	// see each other's in-progress filter edits live — see
	// collection-views.md's draft-view-state section.
	//
	// isDirty is deliberately its own explicit flag rather than a live
	// comparison of draftConfig against persistedConfig: a comparison would
	// depend on the parent re-passing an updated `block` prop once its own
	// Yjs observer round-trips this viewer's own Save, which is real but not
	// synchronous — this viewer's own Save/Discard should clear "unsaved"
	// immediately, not wait on that loop.
	//
	// draftConfig re-syncs to persistedConfig automatically whenever the
	// referenced Collection changes (a brand new embed target) or whenever
	// persistedConfig changes elsewhere *and this viewer has no local edits
	// to lose* (isDirty is false) — an explicit Save from another connection
	// is picked up, but this viewer's own unsaved draft is never silently
	// overwritten.
	// Seeded with a placeholder rather than reading persistedConfig/block
	// directly here — the $effect below (a tracked context) does the real
	// initial sync on its first run, so this never observes a stale snapshot.
	let draftConfig: EmbeddedViewConfig = $state({ viewType: 'table' });
	// The config this viewer's draft was last synced from — captured
	// alongside draftConfig every time it's (re)seeded from persistedConfig,
	// so saveView can diff "what did I actually change" instead of writing
	// the whole draft back (issue #71: a whole-value write would silently
	// clobber a member someone else saved concurrently, e.g. this viewer's
	// stale copy of `sort` overwriting another actor's in-flight sort edit
	// just because this viewer only meant to change `filters`).
	let baseConfig: EmbeddedViewConfig = $state({ viewType: 'table' });
	let isDirty = $state(false);
	let lastTargetId: string | undefined;
	let initialized = false;

	$effect(() => {
		const targetId = block.referencedRecordId;
		const current = persistedConfig;
		if (!initialized || targetId !== lastTargetId) {
			initialized = true;
			lastTargetId = targetId;
			draftConfig = current;
			baseConfig = current;
			isDirty = false;
			return;
		}
		// viewConfigsEqual, not a reference check — persistedConfig recomputes
		// (a new object) on every unrelated Yjs change to this block, so a
		// plain reassignment here would needlessly re-render every nested
		// renderer on every external edit, not just an actual config change.
		if (!isDirty && !viewConfigsEqual(draftConfig, current)) {
			draftConfig = current;
			baseConfig = current;
		}
	});

	function onDraftChange(next: import('$lib/data/views').ViewConfig): void {
		draftConfig = { ...next, viewType: draftConfig.viewType };
		isDirty = true;
	}

	function saveView(): void {
		const patch = diffViewConfig(baseConfig, draftConfig);
		if (Object.keys(patch).length > 0) {
			patchRecordViewConfig(ydoc, block.id, patch, CURRENT_USER);
		}
		// draftConfig is now what this viewer believes is persisted — rebase
		// so a *later* Save only ever diffs members touched since this one,
		// rather than re-diffing against a growing-stale pre-this-save
		// snapshot (which would re-write already-saved fields on every
		// subsequent Save and could clobber a concurrent edit to one of them).
		baseConfig = draftConfig;
		isDirty = false;
	}

	function discardDraft(): void {
		draftConfig = persistedConfig;
		baseConfig = persistedConfig;
		isDirty = false;
	}

	function startChange(): void {
		pickerCollectionId = collection?.id ?? '';
		pickerViewType = block.viewConfig?.viewType ?? 'table';
		changing = true;
	}
</script>

<div class="my-1 rounded-lg border border-border bg-surface/30 p-3">
	{#if isConfigured && !changing}
		<div class="mb-3 flex items-center justify-between">
			<div class="flex items-center gap-2 text-sm font-medium text-fg">
				<Icon name={block.viewConfig?.viewType ?? 'table'} size={16} class="text-accent" />
				<a
					href={resolve('/space/[spaceId]/table/[id]', {
						spaceId: page.params.spaceId!,
						id: collection!.id
					})}
					class="hover:underline"
				>
					{collection!.title || 'Untitled Collection'}
				</a>
				<span class="text-xs text-muted">· {block.viewConfig?.viewType}</span>
			</div>
			<div class="flex items-center gap-2">
				{#if isDirty}
					<span class="text-xs text-muted italic">Unsaved changes</span>
					<button
						type="button"
						onclick={discardDraft}
						class="rounded px-2 py-0.5 text-xs text-muted hover:text-fg"
					>
						Discard
					</button>
					<button
						type="button"
						onclick={saveView}
						class="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg transition-opacity hover:opacity-90"
					>
						Save view
					</button>
				{/if}
				<button
					type="button"
					onclick={startChange}
					class="rounded px-2 py-0.5 text-xs text-muted hover:text-accent"
				>
					Change
				</button>
			</div>
		</div>

		{#if block.viewConfig?.viewType === 'table'}
			<TableCollectionView
				collectionId={collection!.id}
				config={draftConfig}
				onConfigChange={onDraftChange}
				{collections}
			/>
		{:else if block.viewConfig?.viewType === 'board'}
			<BoardCollectionView
				collectionId={collection!.id}
				config={draftConfig}
				onConfigChange={onDraftChange}
				{collections}
			/>
		{:else if block.viewConfig?.viewType === 'calendar'}
			<CalendarCollectionView
				collectionId={collection!.id}
				config={draftConfig}
				onConfigChange={onDraftChange}
				{collections}
			/>
		{/if}
	{:else if isBroken && !changing}
		<div class="flex items-center justify-between" role="alert">
			<span class="flex items-center gap-2 text-sm text-muted italic">
				<Icon name="table" size={16} class="flex-shrink-0 opacity-50" />
				Embedded collection was deleted
			</span>
			<button
				type="button"
				onclick={startChange}
				class="rounded px-2 py-0.5 text-xs text-muted hover:text-accent"
			>
				Change
			</button>
		</div>
	{:else}
		<div class="flex flex-wrap items-center gap-2 text-xs text-muted">
			<Icon name="table" size={15} class="flex-shrink-0 text-accent" />
			<span>Embed a collection view:</span>
			<select
				bind:value={pickerViewType}
				class="rounded border border-border bg-bg px-2 py-1 text-xs text-fg focus:border-accent"
			>
				{#each VIEW_TYPES as vt (vt.value)}
					<option value={vt.value}>{vt.label}</option>
				{/each}
			</select>
			<select
				bind:value={pickerCollectionId}
				class="rounded border border-border bg-bg px-2 py-1 text-xs text-fg focus:border-accent"
			>
				<option value="">Select collection…</option>
				{#each collections as c (c.id)}
					<option value={c.id}>{c.title || 'Untitled'}</option>
				{/each}
			</select>
			<button
				type="button"
				onclick={insert}
				disabled={!pickerCollectionId}
				class="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-40"
			>
				Insert
			</button>
			{#if changing}
				<button
					type="button"
					onclick={() => (changing = false)}
					class="text-xs text-muted hover:text-fg"
				>
					Cancel
				</button>
			{/if}
		</div>
	{/if}
</div>
