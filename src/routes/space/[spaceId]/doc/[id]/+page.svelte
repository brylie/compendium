<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { getShardAwareness, getShardDoc } from '$lib/client/yjs-client';
	import { CURRENT_USER } from '$lib/client/actor';
	import { LOCAL_UI_ORIGIN, transactWithOrigin } from '$lib/mutation-origin';
	import { getDocument, updateDocumentTitle } from '$lib/data/document-ops';
	import {
		createColumnsBlock,
		createRecord,
		deleteRecord,
		detachSyncedBlock,
		duplicateRecord,
		flattenDocumentBlocks,
		getRecord,
		getRecordYText,
		listRecordsForParent,
		parentKindOf,
		setBlockType,
		setRecordCollapsed,
		setRecordReferencedId,
		touchRecordEditor
	} from '$lib/data/record-ops';
	import {
		listSyncedBlockInstances,
		type Backlink,
		type InternalLinkTarget
	} from '$lib/data/links';
	import {
		appendRichTextToYText,
		applyRichTextToYText,
		plainText,
		splitRichTextAt,
		yTextToRichText
	} from '$lib/data/richtext';
	import { actorKey, formatActor, formatTimestamp } from '$lib/data/format';
	import {
		claimBlockPresence,
		releaseBlockPresence,
		subscribeHeldByOthers
	} from '$lib/client/presence';
	import { redo, subscribeUndoRedoState, undo } from '$lib/client/undo';
	import { createLinkComposer } from '$lib/client/link-composer.svelte';
	import { createBlockSelection } from '$lib/client/block-selection.svelte';
	import { createBlockDrag } from '$lib/client/block-drag.svelte';
	import { BLOCK_CAPABILITIES, blockCapabilitiesFor } from '$lib/data/block-capabilities';
	import {
		blockTypes,
		type ActorId,
		type BlockType,
		type TextMarks,
		type WorkspaceRecord
	} from '$lib/data/types';
	import BlockEditor from '$lib/components/BlockEditor.svelte';
	import BlockRow, { type BlockEditorHandle } from '$lib/components/BlockRow.svelte';
	import SlashMenu from './SlashMenu.svelte';
	import Toolbar from './Toolbar.svelte';
	import LinkComposerDialog from './LinkComposerDialog.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import CollectionViewBlock from '$lib/components/CollectionViewBlock.svelte';
	import CalloutBlock from '$lib/components/CalloutBlock.svelte';
	import ChildPagesBlock from '$lib/components/ChildPagesBlock.svelte';
	import ColumnsBlock from '$lib/components/ColumnsBlock.svelte';
	import PromptDialog from '$lib/components/PromptDialog.svelte';
	import SyncedBlockUsage from '$lib/components/SyncedBlockUsage.svelte';
	import BacklinksPanel from '$lib/components/BacklinksPanel.svelte';
	import DocumentOutline from '$lib/components/DocumentOutline.svelte';
	import type { PageProps } from './$types';

	// Toggled onto holdAnnouncement below to guarantee a screen reader
	// re-announces it even when two consecutive, distinct transitions
	// happen to produce identical wording — a live region only re-fires on
	// an actual text change, and this doesn't affect what's read aloud.
	const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

	let { data }: PageProps = $props();

	let ydoc: ReturnType<typeof getShardDoc> | undefined = $state();
	// Initial-render-only snapshot of the SSR-loaded title, shown before ydoc
	// mounts; refresh() (below) is what keeps it in sync with the Y.Doc
	// afterwards, including on navigation to a different document and on
	// remote title edits — untrack() here just tells Svelte that's deliberate.
	let title = $state(untrack(() => data.title));
	let blocks: WorkspaceRecord[] = $state([]);
	// Which Document `blocks` (and `ydoc`) actually reflect right now — set
	// only by refresh(), once the shard for that Document has genuinely
	// resolved. Distinct from `data.documentId` itself: client-side navigation
	// updates `data.documentId` synchronously, but `blocks`/`ydoc` still lag
	// behind it until the async shard-resolution fetch below completes. The
	// hash-navigation $effect (issue #152) reads this, not just
	// `blocks.length`, so it can tell "no blocks because this Document is
	// genuinely empty" apart from "no blocks yet because the *previous*
	// Document's blocks haven't been replaced" — the latter previously let it
	// search the wrong Document's DOM and never retry once the real
	// destination blocks loaded (CodeRabbit review, PR #257).
	let blocksDocumentId: string | undefined = $state();
	let slashMenuBlockId: string | null = $state(null);
	let slashQuery = $state('');
	let heldByOthers: Map<string, ActorId> = $state(new Map());
	let holdAnnouncement = $state('');
	let parentDocTitle: string | null = $state(null);
	let activeBlockId: string | null = $state(null);
	let activeMarks: Partial<Record<keyof TextMarks, boolean>> = $state({});
	let canUndo = $state(false);
	let canRedo = $state(false);
	let syncedBlockDialogId: string | null = $state(null);
	const linkComposer = createLinkComposer((blockId) => blockRefs[blockId]);
	let provenanceAnnouncement = $state('');
	let provenanceAnnouncementTimer: ReturnType<typeof setTimeout> | undefined;
	let reorderAnnouncement = $state('');
	const blockSelection = createBlockSelection({
		getYdoc: () => ydoc,
		announceMoved: (message) => (reorderAnnouncement = message),
		focusDragHandle
	});
	const blockDrag = createBlockDrag({
		getYdoc: () => ydoc,
		getDefaultParentId: () => data.documentId,
		announceMoved: (message) => (reorderAnnouncement = message),
		focusDragHandle,
		selection: blockSelection
	});
	let outlineOpen = $state(false);
	// Briefly highlighted after a List View selection or a #block-<id> deep
	// link lands focus on it — a purely presentational pulse, not stored state.
	let justNavigatedBlockId: string | null = $state(null);
	let justNavigatedTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * Older imported documents may predate per-record attribution. This runtime
	 * guard keeps a legacy block from displaying an invalid actor or timestamp.
	 */
	function hasProvenance(block: WorkspaceRecord): boolean {
		return (
			// WorkspaceRecord.lastEditedBy is a required field per its type, so
			// sonarjs sees this as always-true — but this function's own point is
			// guarding against legacy/imported data that predates that
			// requirement and violates it at runtime, per the doc comment above.
			// eslint-disable-next-line sonarjs/different-types-comparison
			block.lastEditedBy !== undefined &&
			typeof block.lastEditedAt === 'number' &&
			Number.isFinite(block.lastEditedAt)
		);
	}

	// Catalog-backed (data.documents), not derived from ydoc: a sharded
	// Document's own meta entry doesn't live in *this* Document's doc at all
	// (#120) — only its own shard does, which this page has no connection to.
	// Not live, same accepted tradeoff as Sidebar's list.
	const documentMetadataById = $derived(
		new Map(data.documents.map((document) => [document.id, document]))
	);

	// Passed down to every BlockEditor for inline record: wiki-link
	// resolution (title/kind/existence) — an inline link's target is very
	// often a *different* Document, now its own isolated shard (#120) this
	// page's own ydoc has no connection to, so this must come from the
	// catalog-backed data.documents/data.collections rather than a live doc.
	const linkTargets = $derived(
		new Map<string, InternalLinkTarget>([
			...data.documents.map((d): [string, InternalLinkTarget] => [
				d.id,
				{ id: d.id, kind: 'document', title: d.title }
			]),
			...data.collections.map((c): [string, InternalLinkTarget] => [
				c.id,
				{ id: c.id, kind: 'collection', title: c.title }
			])
		])
	);

	let blockRefs: Record<string, BlockEditorHandle | undefined> = $state({});

	function refresh(): void {
		if (!ydoc) return;
		const nextBlocks = listRecordsForParent(ydoc, data.documentId);
		blocks = nextBlocks;
		blocksDocumentId = data.documentId;
		const docMeta = getDocument(ydoc, data.documentId);
		title = docMeta?.title ?? data.title;
		if (docMeta?.parentDocumentId) {
			const parent = documentMetadataById.get(docMeta.parentDocumentId);
			// `||`, not `??`: a Document title can be user-edited down to an
			// empty string (no blank-title validation), and an empty
			// breadcrumb would be worse than this fallback label — unlike a
			// record id, "" is a real value here, not just missing.
			// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
			parentDocTitle = parent?.title || 'Parent document';
		} else {
			parentDocTitle = null;
		}
		const currentActiveBlockId = untrack(() => activeBlockId);
		if (currentActiveBlockId && !nextBlocks.some((block) => block.id === currentActiveBlockId)) {
			activeBlockId = null;
			activeMarks = {};
		}
	}

	function syncToolbarSelection(): void {
		const anchor = document.getSelection()?.anchorNode;
		const element = anchor instanceof Element ? anchor : anchor?.parentElement;
		const editor = element?.closest<HTMLElement>('[data-block-editor-id]');
		const blockId = editor?.dataset.blockEditorId;
		if (!blockId || !blockRefs[blockId]) {
			// Selection moved outside any block editor (e.g. into the
			// sidebar or the title input) — without this, the toolbar kept
			// showing the previously focused block as active and would
			// silently reformat it if a format button were clicked.
			activeBlockId = null;
			activeMarks = {};
			return;
		}
		activeBlockId = blockId;
		activeMarks = blockRefs[blockId]?.getFormatState() ?? {};
	}

	function handleFocusBlock(blockId: string, presenceBlockId = blockId): void {
		activeBlockId = blockId;
		if (awareness) claimBlockPresence(awareness, presenceBlockId);
		syncToolbarSelection();
	}

	function applyToolbarFormat(mark: keyof TextMarks): void {
		const editor = activeBlockId ? blockRefs[activeBlockId] : undefined;
		if (!editor) return;
		if (mark === 'link') {
			linkComposer.open(activeBlockId!);
		} else {
			editor.applyFormat(mark);
		}
		activeMarks = editor.getFormatState();
	}

	// The composer nulls its own blockId once applied, so activeMarks (which
	// drives the toolbar's link-active highlight) must be captured against the
	// block it targeted before calling apply(), not after.
	function applyLink(): void {
		const editor = linkComposer.blockId ? blockRefs[linkComposer.blockId] : undefined;
		linkComposer.apply();
		if (editor) activeMarks = editor.getFormatState();
	}

	function documentLocation(documentId: string): string {
		const parts: string[] = [];
		const visited = new SvelteSet<string>();
		let current = documentMetadataById.get(documentId);
		while (current && !visited.has(current.id)) {
			visited.add(current.id);
			parts.unshift(current.title || 'Untitled');
			current = current.parentDocumentId
				? documentMetadataById.get(current.parentDocumentId)
				: undefined;
		}
		return parts.join(' / ');
	}

	// Word-processor convention: clicking a text-formatting control (a
	// heading level, a list type, quote, etc.) while a block is active
	// converts *that* block in place — the same way Word/Docs' toolbar
	// turns the current paragraph into a bulleted list rather than
	// inserting a new empty list item after it. Structural types (table,
	// divider, embed, ...) aren't a "turn this text into" operation, so
	// those still insert a new block; so does clicking with nothing active
	// (e.g. starting an empty Document from the toolbar).
	function insertToolbarBlock(blockType: BlockType): void {
		slashMenuBlockId = null;
		// A generic lookup (not blocks.find), since the active block may be
		// nested inside a column (issue #148) rather than in the Document's
		// own top-level flat list.
		const active = activeBlockId && ydoc ? getRecord(ydoc, activeBlockId) : undefined;
		if (
			activeBlockId &&
			ydoc &&
			blockHoldsFreeformText(blockType) &&
			blockHoldsFreeformText(active?.blockType)
		) {
			// Toggle off: clicking the control for the block's own current
			// type converts it back to a plain paragraph — the same toggle
			// convention as clicking "Bulleted List" again on an
			// already-bulleted line in Word/Docs to remove the list
			// formatting, rather than the button being a one-way street.
			const targetType = active?.blockType === blockType ? 'paragraph' : blockType;
			setBlockType(ydoc, activeBlockId, targetType, CURRENT_USER);
			return;
		}
		const target = resolveToolbarInsertTarget(activeBlockId ?? blocks.at(-1)?.id, blockType);
		if (blockType === 'columns') {
			// Like the slash menu's own columns entry — can't be produced by a
			// plain blockType flip, needs real column children created
			// alongside it. resolveToolbarInsertTarget already escalates to
			// the Document's top level for a type not in columnChildBlockTypes
			// (which 'columns' never is — no nested columns-in-columns), so
			// target.parentId is always data.documentId here.
			if (!ydoc) return;
			const currentDoc = ydoc;
			transactWithOrigin(ydoc, LOCAL_UI_ORIGIN, () =>
				createColumnsBlock(
					currentDoc,
					{ parentId: target.parentId, afterRecordId: target.afterId },
					CURRENT_USER
				)
			);
			return;
		}
		void addBlockAfter(target.afterId, blockType, target.parentId);
	}

	let awareness: ReturnType<typeof getShardAwareness> | undefined = $state();

	// Resolves this Document's real shard (#120) and (re)connects whenever
	// data.documentId changes — SvelteKit reuses this component instance
	// across client-side navigations between two /doc/[id] routes, so this
	// can't be a one-time onMount. Mirrors table/[id]/+page.svelte's
	// identical pattern, plus this page's own presence/undo subscriptions,
	// which both need this Document's real shard's Awareness/Y.Doc, not a
	// single shared instance.
	$effect(() => {
		const id = data.documentId;
		let cancelled = false;
		let cleanup: (() => void) | undefined;

		// Cleared synchronously, before the shard-resolution fetch below even
		// starts — not after it resolves. Documents aren't sharded (#120), so a
		// selection from the previously-viewed Document stays fully valid
		// against the shared Y.Doc; leaving this inside the async block below
		// would leave the old bulk action bar active (and its Delete/Duplicate/
		// Move fully operable against the old Document's real blocks) for the
		// whole network round-trip, not just eliminate the stale state after
		// the fact.
		blockSelection.clear();

		(async () => {
			const res = await fetch(`/api/documents/${id}/shard`);
			const { shardId: resolvedShardId } = await res.json();
			if (cancelled) return;

			const doc = getShardDoc(resolvedShardId);
			const docAwareness = getShardAwareness(resolvedShardId);
			ydoc = doc;
			awareness = docAwareness;

			const recordsMap = doc.getMap('records');
			const documentsMap = doc.getMap('documents');
			const observer = () => refresh();
			recordsMap.observeDeep(observer);
			documentsMap.observeDeep(observer);
			refresh();

			// Reset immediately: this component instance is reused across
			// client-side navigation to a different Document (see the comment
			// above this $effect), so a stale announcement from the
			// previously-viewed document must not linger until this
			// document's first real transition.
			holdAnnouncement = '';
			let previousHeldByOthers = new Map<string, ActorId>();
			// The subscription's first callback reports presence as of connect
			// time, not a transition — without this, every actor who was
			// already editing before this client joined gets misreported as
			// having "just started".
			let isFirstSnapshot = true;
			let announceToggle = false;
			const unsubscribePresence = subscribeHeldByOthers(docAwareness, (held) => {
				const messages: string[] = [];
				for (const [recordId, actor] of held) {
					const previousActor = previousHeldByOthers.get(recordId);
					if (!previousActor) {
						if (!isFirstSnapshot) {
							messages.push(`${formatActor(actor)} started editing a block`);
						}
					} else if (actorKey(previousActor) !== actorKey(actor)) {
						// One actor released this block and another claimed it
						// in the same update — both halves of that handoff need
						// announcing, not just a silent no-op because the
						// record id itself never left the map.
						messages.push(`${formatActor(previousActor)} finished editing a block`);
						messages.push(`${formatActor(actor)} started editing a block`);
					}
				}
				for (const [recordId, actor] of previousHeldByOthers) {
					if (!held.has(recordId)) {
						messages.push(`${formatActor(actor)} finished editing a block`);
					}
				}
				if (messages.length > 0) {
					announceToggle = !announceToggle;
					holdAnnouncement = (announceToggle ? ZERO_WIDTH_SPACE : '') + messages.join('; ');
				}
				previousHeldByOthers = held;
				isFirstSnapshot = false;
				heldByOthers = held;
			});

			// Subscribed immediately once the shard resolves, before any local
			// edit can happen — this is what puts this Document's Y.UndoManager
			// in place from the start, since it only tracks transactions made
			// after it exists.
			const unsubscribeUndoRedo = subscribeUndoRedoState(doc, (state) => {
				canUndo = state.canUndo;
				canRedo = state.canRedo;
			});

			cleanup = () => {
				recordsMap.unobserveDeep(observer);
				documentsMap.unobserveDeep(observer);
				unsubscribePresence();
				unsubscribeUndoRedo();
				releaseBlockPresence(docAwareness);
			};
			// A rejection here (network failure, bad response) previously
			// vanished as a silent unhandled rejection — this at least
			// surfaces it, without inventing a toast/error-UI system this
			// lint pass isn't scoped to add.
		})().catch((err: unknown) => {
			console.error(`Failed to resolve shard for document ${id}:`, err);
		});

		return () => {
			cancelled = true;
			cleanup?.();
		};
	});

	// Word-processor convention: Cmd/Ctrl+Z undoes this tab's own last local
	// action wherever it happened (a keystroke, a block insert/delete, a
	// title edit — anything under the Y.UndoManager's scope), and
	// Cmd/Ctrl+Shift+Z (or Ctrl+Y, the Windows/Linux convention) redoes it.
	// Global on the document rather than scoped to a single block, since the
	// action being undone might not be in the block that currently has focus
	// (e.g. undoing a delete brings back a block that no longer exists to
	// focus).
	function handleGlobalKeydown(event: KeyboardEvent): void {
		if (!ydoc) return;
		const key = event.key.toLowerCase();
		if ((event.metaKey || event.ctrlKey) && key === 'z') {
			event.preventDefault();
			if (event.shiftKey) redo(ydoc);
			else undo(ydoc);
			return;
		}
		if (event.ctrlKey && !event.metaKey && key === 'y') {
			event.preventDefault();
			redo(ydoc);
			return;
		}
		// A block-editor's own Escape uses (e.g. the drag handle's own
		// cancel-drag listener, the link composer) all stop propagation before
		// this document-level listener would see them, so this only ever fires
		// for a plain, otherwise-unhandled Escape — safe to use as "clear the
		// current multi-selection" (issue #152).
		if (event.key === 'Escape' && blockSelection.ids.size > 0) {
			blockSelection.clear();
		}
	}

	// Guards against a leaked window listener if this page unmounts mid-drag
	// (e.g. client-side navigation away while a pointer is still down).
	$effect(() => {
		return () => blockDrag.dispose();
	});

	// Deep-link support for "Copy link to block" (issue #152) — once this
	// Document's blocks have actually loaded, a `#block-<id>` URL fragment
	// scrolls to and focuses that block the same way a List View click does.
	// Guarded per documentId so it fires once per navigation, not on every
	// subsequent blocks refresh (any later edit anywhere in the Document also
	// reassigns `blocks`, which would otherwise re-trigger this on every
	// keystroke).
	//
	// Gated on `blocksDocumentId === data.documentId`, not just `blocks.length
	// === 0`: this effect also reads `data.documentId`, so a client-side
	// navigation to a different Document (e.g. a cross-document Backlinks/
	// SyncedBlockUsage link, which sets the hash and navigates in the same
	// step) re-runs it immediately — before the shard-resolution $effect
	// above has replaced `blocks` with the *new* Document's own. Checking
	// `blocks.length` alone couldn't tell "not loaded yet" apart from "the
	// previous Document's (non-empty) blocks, still stale" — it would search
	// the previous Document's DOM, find nothing, and — because it marks
	// `hashNavigatedForDocument` for the new id regardless — never retry once
	// the real destination blocks actually did load (CodeRabbit review,
	// PR #257).
	let hashNavigatedForDocument: string | null = $state(null);
	$effect(() => {
		if (!ydoc || blocksDocumentId !== data.documentId) return;
		if (hashNavigatedForDocument === data.documentId) return;
		hashNavigatedForDocument = data.documentId;
		const match = /^#block-(.+)$/.exec(page.url.hash);
		if (match) void navigateToBlock(match[1]);
	});

	function handleTitleInput(event: Event): void {
		if (!ydoc) return;
		title = (event.target as HTMLInputElement).value;
		updateDocumentTitle(ydoc, data.documentId, title);
	}

	async function addBlockAfter(
		afterId?: string,
		blockType: BlockType = 'paragraph',
		parentId: string = data.documentId
	): Promise<void> {
		if (!ydoc) return;
		const currentDoc = ydoc;
		const record = transactWithOrigin(ydoc, LOCAL_UI_ORIGIN, () =>
			createRecord(currentDoc, { parentId, blockType, afterRecordId: afterId }, CURRENT_USER)
		);
		await tick();
		blockRefs[record.id]?.focusEditor(true);
	}

	// Resolves where a *toolbar-triggered* insert (as opposed to Enter/the
	// slash menu, which both already know their own container) actually
	// belongs: normally right after the active block, in its own container.
	// But a column only holds its own curated BLOCK_CAPABILITIES.column
	// .childBlockTypes subset (issue #148/#229, see services/records.ts's own
	// creation-time validation) — inserting an unsupported structural type
	// (table, embed, ...) while a column's block is active instead escalates
	// to right after the enclosing columns block itself, at the Document's
	// top level, rather than writing a block type ColumnsBlock.svelte has no
	// idea how to render into a column's own recordIds array.
	function resolveToolbarInsertTarget(
		afterId: string | undefined,
		blockType: BlockType
	): { parentId: string; afterId: string | undefined } {
		const fallback = { parentId: data.documentId, afterId };
		if (!ydoc || !afterId) return fallback;
		const active = getRecord(ydoc, afterId);
		if (!active) return fallback;
		if (parentKindOf(ydoc, active.parentId) !== 'record') {
			return { parentId: active.parentId, afterId };
		}
		const allowedInColumn = BLOCK_CAPABILITIES.column.childBlockTypes;
		if (allowedInColumn?.includes(blockType)) return { parentId: active.parentId, afterId };
		const column = getRecord(ydoc, active.parentId);
		const columnsBlock = column ? getRecord(ydoc, column.parentId) : undefined;
		return { parentId: data.documentId, afterId: columnsBlock?.id ?? afterId };
	}

	const LIST_BLOCK_TYPES: readonly BlockType[] = [
		'bulleted_list_item',
		'numbered_list_item',
		'to_do'
	];

	// Every Document-kind record gets a `content` Y.Text at creation
	// regardless of blockType (see createRecord), so its mere presence can't
	// distinguish a block that holds free-form inline text from one that
	// doesn't — these block types have a structurally different content
	// shape (a table's rows, a divider's absence of content, a reference to
	// another record) where "append/merge plain text into it" isn't a
	// meaningful operation. Used to gate both Backspace-joins-the-previous-
	// block and the toolbar's convert-current-block-in-place behavior.
	// Driven by BLOCK_CAPABILITIES (issue #229) instead of its own list.
	// blockCapabilitiesFor (not direct BLOCK_CAPABILITIES indexing) since
	// `blockType` here can come straight off an existing record's own live
	// Yjs field, which TypedYMap.get casts but never validates.
	function blockHoldsFreeformText(blockType?: BlockType): boolean {
		return !!blockType && blockCapabilitiesFor(blockType).holdsFreeformText;
	}

	function isBlockTextEmpty(blockId: string): boolean {
		if (!ydoc) return true;
		const ytext = getRecordYText(ydoc, blockId);
		return !ytext || plainText(yTextToRichText(ytext)).length === 0;
	}

	// Splits `block`'s text at caretOffset: text before the caret stays in
	// the existing block, text after it (with marks intact) moves into a new
	// block of `nextBlockType`, created immediately after — the standard
	// "Enter splits the line" behavior, not just "Enter appends an empty
	// line" (which silently discarded the caret position). Which of the two
	// blocks ends up focused depends on the caret position — see below.
	async function splitBlockOnEnter(
		block: WorkspaceRecord,
		caretOffset: number,
		nextBlockType: BlockType
	): Promise<void> {
		if (!ydoc) return;
		const currentDoc = ydoc;
		const ytext = getRecordYText(ydoc, block.id);
		const richText = ytext ? yTextToRichText(ytext) : { runs: [] };
		const offset = ytext ? Math.min(Math.max(0, caretOffset), ytext.length) : 0;
		const { after } = splitRichTextAt(richText, offset);

		if (ytext && offset < ytext.length) {
			const doc = ytext.doc;
			const trim = () => ytext.delete(offset, ytext.length - offset);
			if (doc) doc.transact(trim, LOCAL_UI_ORIGIN);
			else trim();
		}

		const record = transactWithOrigin(ydoc, LOCAL_UI_ORIGIN, () =>
			createRecord(
				currentDoc,
				{ parentId: data.documentId, blockType: nextBlockType, afterRecordId: block.id },
				CURRENT_USER
			)
		);
		if (after.runs.length > 0) {
			const newYtext = getRecordYText(ydoc, record.id);
			if (newYtext) {
				transactWithOrigin(currentDoc, LOCAL_UI_ORIGIN, () =>
					applyRichTextToYText(newYtext, after)
				);
			}
		}
		await tick();
		// Caret at the very start (offset 0): `block` becomes the empty line
		// inserted above, and `record` (the new block right after it) is the
		// one that ends up holding all the real content. Focus follows
		// `block` — the empty one — not the content, so a second Enter there
		// hits the ordinary "empty list item exits the list" rule instead of
		// cascading into more empty items while the real content keeps
		// hopping into fresh blocks (the original bug this branch fixes).
		// Any other caret position focuses the new block as usual — it's the
		// one that picked up whatever came after the caret.
		if (offset === 0) {
			blockRefs[block.id]?.focusEditor(true);
		} else {
			blockRefs[record.id]?.focusEditor(true);
		}
	}

	// Enter on a list item continues the list (same block type) so a person
	// can keep pressing Enter to add items without reaching for the toolbar
	// each time. Enter on an *empty* list item exits the list instead —
	// converting that item to a paragraph in place, rather than adding yet
	// another empty item — mirroring the standard list-editing convention
	// (Notion, Google Docs, etc.) of using an empty item as the "done" signal.
	async function handleEnter(block: WorkspaceRecord, caretOffset: number): Promise<void> {
		const blockType = block.blockType ?? 'paragraph';
		const isList = LIST_BLOCK_TYPES.includes(blockType);
		if (isList && isBlockTextEmpty(block.id)) {
			if (!ydoc) return;
			setBlockType(ydoc, block.id, 'paragraph', CURRENT_USER);
			await tick();
			blockRefs[block.id]?.focusEditor(true);
			return;
		}
		await splitBlockOnEnter(block, caretOffset, isList ? blockType : 'paragraph');
	}

	// Backspace at the very start of a block: word-processor convention
	// joins its text onto the end of the previous block, same as it would
	// join two lines of a single document, rather than just discarding the
	// current block. An empty current block still "joins" — there's simply
	// nothing to append — matching the previous, simpler delete-and-move-
	// focus behavior. If the previous block can't hold text (e.g. a
	// divider), a non-empty current block is left alone rather than
	// deleted with its content silently lost.
	async function handleBackspace(block: WorkspaceRecord, index: number): Promise<void> {
		if (!ydoc) return;
		const currentDoc = ydoc;
		const previous = blocks[index - 1];
		if (!previous) return;

		const currentYtext = getRecordYText(currentDoc, block.id);
		const currentIsEmpty = !currentYtext || currentYtext.length === 0;
		const previousHoldsText = blockHoldsFreeformText(previous.blockType);
		if (!currentIsEmpty && !previousHoldsText) return;

		const previousYtext = previousHoldsText ? getRecordYText(currentDoc, previous.id) : undefined;
		const joinOffset = previousYtext?.length ?? 0;
		transactWithOrigin(currentDoc, LOCAL_UI_ORIGIN, () => {
			if (!currentIsEmpty && previousYtext && currentYtext) {
				appendRichTextToYText(previousYtext, yTextToRichText(currentYtext));
			}
			deleteRecord(currentDoc, block.id);
		});
		await tick();
		blockRefs[previous.id]?.focusEditor(joinOffset);
	}

	// Held blocks (another actor editing) render a placeholder instead of a
	// BlockEditor (see the {#if holder} branch below), so blockRefs has no
	// entry for them — skip past any such gap to the next block that does
	// have a real editor, rather than stalling ArrowUp/ArrowDown at the edge.
	function handleArrowUpAtStart(index: number, clientX: number | null): boolean {
		for (let i = index - 1; i >= 0; i--) {
			const editor = blockRefs[blocks[i].id];
			if (editor) {
				editor.focusEditorAtLine('last', clientX);
				return true;
			}
		}
		return false;
	}

	function handleArrowDownAtEnd(index: number, clientX: number | null): boolean {
		for (let i = index + 1; i < blocks.length; i++) {
			const editor = blockRefs[blocks[i].id];
			if (editor) {
				editor.focusEditorAtLine('first', clientX);
				return true;
			}
		}
		return false;
	}

	// Block reordering (#40, extracted to blockDrag for #241) — a visible move
	// handle in each block's gutter, draggable with the pointer or operable
	// with the keyboard once focused. focusDragHandle stays here rather than
	// inside blockDrag/blockSelection since both controllers need it.
	async function focusDragHandle(blockId: string): Promise<void> {
		await tick();
		document.querySelector<HTMLElement>(`[data-drag-handle="${CSS.escape(blockId)}"]`)?.focus();
	}

	/** Updates live provenance for the record whose editable text just changed. */
	function handleBlockInput(blockId: string, editedRecordId = blockId): void {
		if (!ydoc) return;
		touchRecordEditor(ydoc, editedRecordId, CURRENT_USER);
		clearTimeout(provenanceAnnouncementTimer);
		provenanceAnnouncementTimer = setTimeout(() => {
			const record = getRecord(ydoc!, editedRecordId);
			if (record && hasProvenance(record)) {
				provenanceAnnouncement = `Last edited by ${formatActor(record.lastEditedBy)} at ${formatTimestamp(record.lastEditedAt)}.`;
			}
		}, 800);
		if (slashMenuBlockId !== blockId) return;
		const ytext = getRecordYText(ydoc, editedRecordId);
		const text = ytext ? plainText(yTextToRichText(ytext)) : '';
		if (!text.startsWith('/')) {
			slashMenuBlockId = null;
			return;
		}
		slashQuery = text.slice(1);
	}

	function openSlashMenu(blockId: string): void {
		slashMenuBlockId = blockId;
		slashQuery = '';
	}

	function selectSlashCommand(blockId: string, blockType: BlockType): void {
		if (!ydoc) return;
		const ytext = getRecordYText(ydoc, blockId);
		if (ytext) {
			const doc = ytext.doc;
			const clear = () => ytext.delete(0, ytext.length);
			if (doc) doc.transact(clear, LOCAL_UI_ORIGIN);
			else clear();
		}
		// A columns block (issue #148) can't be produced by a plain blockType
		// flip the way every other slash command is — it needs real column
		// children created alongside it (createColumnsBlock), so this always
		// inserts a new block after the triggering one instead, leaving that
		// one as an empty paragraph (its "/columns" text already cleared
		// above), rather than repurposing it in place.
		if (blockType === 'columns') {
			const currentDoc = ydoc;
			const columns = transactWithOrigin(ydoc, LOCAL_UI_ORIGIN, () =>
				createColumnsBlock(
					currentDoc,
					{ parentId: data.documentId, afterRecordId: blockId },
					CURRENT_USER
				)
			);
			slashMenuBlockId = null;
			const firstColumnId = columns.childRecordIds?.[0];
			const firstBlockId = firstColumnId
				? getRecord(currentDoc, firstColumnId)?.childRecordIds?.[0]
				: undefined;
			if (firstBlockId) void tick().then(() => blockRefs[firstBlockId]?.focusEditor(true));
			return;
		}
		setBlockType(ydoc, blockId, blockType, CURRENT_USER);
		slashMenuBlockId = null;
		void tick().then(() => blockRefs[blockId]?.focusEditor(true));
	}

	function toggleCollapseState(block: WorkspaceRecord): void {
		if (!ydoc) return;
		setRecordCollapsed(ydoc, block.id, !block.collapsed, CURRENT_USER);
	}

	function handleLinkSyncedBlock(blockId: string): void {
		syncedBlockDialogId = blockId;
	}

	// ---------------------------------------------------------------------
	// Block action menu (issue #152) — duplicate/delete/convert/copy-link/
	// move, offered per-block via BlockActionMenu.svelte's "…" trigger next
	// to the move handle. Move up/down reuse moveBlock (defined above, the
	// same function the drag handle's own Home/End/ArrowUp/ArrowDown already
	// call) rather than duplicating that logic.
	// ---------------------------------------------------------------------

	// The text-bearing BlockTypes a block can be converted between in place,
	// per rich-text-toolbar.md §5 — the exact set that keeps its text across a
	// setBlockType call. Structural/reference/container types (table, embed,
	// page_link, synced_block, table_of_contents, child_pages, collection_view,
	// columns/column) have no in-place conversion target and are excluded from
	// the menu's "Convert to" list entirely, matching the toolbar's own rule.
	// Type membership comes from BLOCK_CAPABILITIES's holdsFreeformText field
	// (issue #229) — only the display label has no other source of truth and
	// stays hand-maintained here.
	const CONVERTIBLE_BLOCK_TYPE_LABELS: Partial<Record<BlockType, string>> = {
		paragraph: 'Text',
		heading_1: 'Heading 1',
		heading_2: 'Heading 2',
		heading_3: 'Heading 3',
		heading_4: 'Heading 4',
		bulleted_list_item: 'Bulleted list',
		numbered_list_item: 'Numbered list',
		to_do: 'To-do',
		quote: 'Quote',
		callout: 'Callout',
		toggle: 'Toggle',
		code: 'Code'
	};

	// Throws rather than silently falling back to the raw `type` discriminator
	// as a label — a missing entry here should fail loudly (surfacing on any
	// render of this Document page, including in tests) the same way a
	// missing BLOCK_CAPABILITIES entry already does via block-capabilities
	// .test.ts, not leak an internal identifier into the "Convert to" menu.
	const CONVERTIBLE_BLOCK_TYPES: { type: BlockType; label: string }[] = blockTypes
		.filter((type) => BLOCK_CAPABILITIES[type].holdsFreeformText)
		.map((type) => {
			const label = CONVERTIBLE_BLOCK_TYPE_LABELS[type];
			if (!label) {
				throw new Error(
					`CONVERTIBLE_BLOCK_TYPE_LABELS is missing an entry for text-bearing block type "${type}".`
				);
			}
			return { type, label };
		});

	// A column's own curated child-type subset (data-model.md §3.1) excludes
	// callout/toggle/code entirely, so those three are dropped from the
	// "Convert to" list offered *inside* a column — converting a column's
	// block to one of them would produce a block type BLOCK_CAPABILITIES
	// .column.childBlockTypes (and services/records.ts's own creation-time
	// validation) doesn't allow there.
	const COLUMN_CONVERTIBLE_BLOCK_TYPES = CONVERTIBLE_BLOCK_TYPES.filter((c) =>
		BLOCK_CAPABILITIES.column.childBlockTypes?.includes(c.type)
	);

	// The block types BlockRow.svelte's own generic content dispatch doesn't
	// know how to render (issue #239) — never produced inside a column, since
	// they all fall outside BLOCK_CAPABILITIES.column.childBlockTypes (the
	// same curated subset COLUMN_CONVERTIBLE_BLOCK_TYPES above excludes them
	// from), so only the Document's own top-level flow ever supplies the
	// `customContent` snippet that handles them.
	const BLOCK_ROW_CUSTOM_CONTENT_TYPES: readonly BlockType[] = [
		'callout',
		'code',
		'table_of_contents',
		'synced_block',
		'page_link',
		'collection_view',
		'child_pages',
		'columns'
	];

	function duplicateBlock(blockId: string): void {
		if (!ydoc) return;
		const copy = duplicateRecord(ydoc, blockId, CURRENT_USER);
		void tick().then(() => blockRefs[copy.id]?.focusEditor(true));
	}

	// Focuses the previous sibling (or the next one, if the deleted block was
	// first) after deletion — the same "focus lands somewhere sensible, never
	// nowhere" convention handleBackspace already follows when it deletes an
	// empty block.
	function deleteBlockViaMenu(blockId: string): void {
		if (!ydoc) return;
		const currentDoc = ydoc;
		const record = getRecord(currentDoc, blockId);
		if (!record) return;
		const siblings = listRecordsForParent(currentDoc, record.parentId);
		const index = siblings.findIndex((s) => s.id === blockId);
		const fallback = siblings[index - 1] ?? siblings[index + 1];
		transactWithOrigin(currentDoc, LOCAL_UI_ORIGIN, () => deleteRecord(currentDoc, blockId));
		blockSelection.ids.delete(blockId);
		if (fallback) void tick().then(() => blockRefs[fallback.id]?.focusEditor(false));
	}

	function convertBlockViaMenu(blockId: string, blockType: BlockType): void {
		if (!ydoc) return;
		setBlockType(ydoc, blockId, blockType, CURRENT_USER);
		void tick().then(() => blockRefs[blockId]?.focusEditor(true));
	}

	async function copyBlockLink(blockId: string): Promise<void> {
		const url = `${window.location.origin}${page.url.pathname}#block-${blockId}`;
		try {
			await navigator.clipboard.writeText(url);
			provenanceAnnouncement = 'Link to block copied.';
		} catch {
			provenanceAnnouncement = 'Could not copy the link. Please try again.';
		}
	}

	// Shared by the List View outline (click an entry) and the #block-<id>
	// deep-link handled on mount below — scrolls the row into view, focuses
	// its editor when one exists (a top-level or column block; a structural
	// block with no BlockEditor just scrolls), and pulses a brief highlight so
	// the destination is visually obvious even when it lands mid-viewport.
	async function navigateToBlock(blockId: string): Promise<void> {
		await tick();
		document
			.getElementById(`block-${blockId}`)
			?.scrollIntoView({ behavior: 'smooth', block: 'center' });
		blockRefs[blockId]?.focusEditor(true);
		justNavigatedBlockId = blockId;
		clearTimeout(justNavigatedTimer);
		justNavigatedTimer = setTimeout(() => {
			justNavigatedBlockId = null;
		}, 1500);
	}

	// Computed heading list for Table of Contents blocks
	let headings = $derived(
		blocks.filter((b) =>
			['heading_1', 'heading_2', 'heading_3', 'heading_4'].includes(b.blockType ?? '')
		)
	);

	// Full document order for the List View outline (issue #152) — includes
	// blocks nested inside columns, unlike `blocks`/`headings` above, which
	// only cover the Document's own top-level flow. `blocks` is read here
	// purely as this derived's reactivity trigger (refresh() above already
	// reassigns it on every observed mutation anywhere in the Document,
	// including inside a column — see ColumnsBlock.svelte's own comment on
	// that same observeDeep) — flattenDocumentBlocks re-reads the live ydoc
	// itself rather than being derived from `blocks`' own contents.
	let outlineBlocks = $derived(ydoc && blocks ? flattenDocumentBlocks(ydoc, data.documentId) : []);

	function getHeadingText(recordId: string): string {
		if (!ydoc) return '';
		const ytext = getRecordYText(ydoc, recordId);
		return ytext ? plainText(yTextToRichText(ytext)) : '';
	}

	// A synced_block mirrors another record's content — its Y.Text, hold
	// state, and edit provenance all resolve through that target record, not
	// the synced_block record itself. Every other block type resolves
	// through its own id. Was three separately-inlined copies of this same
	// condition in the template below; factored out once both to de-nest
	// and to keep them from drifting out of sync with each other.
	// Whether this block's row should escape the page's content-width column
	// (issue #150) — currently only collection_view blocks expose the UI
	// toggle for this (CollectionViewBlock.svelte), so this stays the gate
	// even though WorkspaceRecord.fullWidth itself isn't type-restricted.
	function isBlockFullWidth(block: WorkspaceRecord): boolean {
		return block.blockType === 'collection_view' && block.fullWidth === true;
	}

	function syncedBlockTargetId(block: WorkspaceRecord): string {
		return block.blockType === 'synced_block' && block.referencedRecordId
			? block.referencedRecordId
			: block.id;
	}

	/**
	 * Every *other* location in `sourceId`'s sync group, from the perspective
	 * of whichever block (`excludeRecordId`) is currently rendering — the
	 * source itself when called for a plain block, or one particular
	 * synced_block instance when called for one. Issue #153's "used in N
	 * places": the source's own row counts as one location too, not just its
	 * instances, so this always prepends it (when it isn't the block asking)
	 * ahead of `listSyncedBlockInstances`' sibling instances (also excluding
	 * self). Same-document only today — see listSyncedBlockInstances' own
	 * comment on why a genuinely cross-Document instance can't appear here
	 * (or exist at all) until synced blocks are shard-aware.
	 */
	function syncGroupLocations(sourceId: string, excludeRecordId: string): Backlink[] {
		if (!ydoc) return [];
		const others = listSyncedBlockInstances(ydoc, sourceId).filter(
			(instance) => instance.sourceRecordId !== excludeRecordId
		);
		const source = getRecord(ydoc, sourceId);
		if (!source || source.id === excludeRecordId) return others;
		const sourceText = getRecordYText(ydoc, source.id);
		const context = sourceText ? plainText(yTextToRichText(sourceText)).trim() : '';
		return [
			{
				sourceDocumentId: data.documentId,
				sourceDocumentTitle: title || 'Untitled Document',
				sourceRecordId: source.id,
				context: context || 'Synced source'
			},
			...others
		];
	}

	function handleDetachSyncedBlock(blockId: string): void {
		if (!ydoc) return;
		detachSyncedBlock(ydoc, blockId, CURRENT_USER);
	}

	function getHeadingLevel(blockType?: BlockType): number {
		switch (blockType) {
			case 'heading_1':
				return 1;
			case 'heading_2':
				return 2;
			case 'heading_3':
				return 3;
			case 'heading_4':
				return 4;
			default:
				return 1;
		}
	}

	async function handleTitleKeydown(e: KeyboardEvent): Promise<void> {
		if (e.key === 'Enter' || e.key === 'ArrowDown') {
			e.preventDefault();
			if (blocks.length > 0) {
				blockRefs[blocks[0].id]?.focusEditor(true);
			} else {
				await addBlockAfter();
			}
		}
	}
</script>

<svelte:document onselectionchange={syncToolbarSelection} onkeydown={handleGlobalKeydown} />

<svelte:head>
	<title>{title || 'Untitled'} · Compendium</title>
</svelte:head>

<Toolbar
	{activeMarks}
	hasActiveEditor={activeBlockId !== null}
	{canUndo}
	{canRedo}
	onFormat={applyToolbarFormat}
	onInsert={insertToolbarBlock}
	onUndo={() => ydoc && undo(ydoc)}
	onRedo={() => ydoc && redo(ydoc)}
/>

<div class="mx-auto max-w-3xl px-6 pt-10">
	<!-- Breadcrumb / Hierarchy nav -->
	<nav class="mb-4 flex items-center gap-1.5 text-xs text-muted">
		<a
			href={resolve('/space/[spaceId]', { spaceId: page.params.spaceId! })}
			class="flex items-center gap-1 transition-colors hover:text-accent"
		>
			<span>Workspace</span>
		</a>
		{#if parentDocTitle}
			<span>/</span>
			<span class="truncate">{parentDocTitle}</span>
		{/if}
		<span>/</span>
		<span class="truncate font-medium text-fg">{title || 'Untitled'}</span>
		<button
			type="button"
			onclick={() => (outlineOpen = !outlineOpen)}
			class="ml-auto flex flex-shrink-0 items-center gap-1 rounded px-1.5 py-1 text-muted transition-colors hover:bg-surface hover:text-fg"
			class:text-accent={outlineOpen}
			aria-pressed={outlineOpen}
			aria-label="{outlineOpen ? 'Close' : 'Open'} document List View"
			title="List View"
		>
			<Icon name="list-view" size={15} />
		</button>
	</nav>

	<!-- Document Title -->
	<input
		class="w-full border-none bg-transparent font-display text-3xl font-semibold tracking-tight text-fg outline-none placeholder:text-muted/50 focus:ring-0 md:text-4xl"
		value={title}
		oninput={handleTitleInput}
		onkeydown={handleTitleKeydown}
		placeholder="Untitled document"
	/>

	<!-- Screen-reader announcements for collaborative hold state (issue #18) -->
	<div class="sr-only" role="status" aria-live="polite">{holdAnnouncement}</div>

	<!--
		Backlinks panel (issue #83): re-added after #120 removed the version
		built on $lib/data/links.ts#listIncomingLinks, whose reverse index
		can't span per-Document shards. Powered instead by
		services/documents.ts#listBacklinks, a server-side fan-out across every
		Document's own shard (the same pattern search_workspace already
		established, #191) — not the old client-side incremental index. Each
		entry links to its exact referring block (#block-<id>), not just the
		referring Document, with the same navigate/reveal/highlight mechanism
		SyncedBlockUsage.svelte already uses.
	-->
	<BacklinksPanel
		spaceId={page.params.spaceId!}
		currentDocumentId={data.documentId}
		backlinks={data.backlinks}
		onJumpTo={(documentId, recordId) => {
			if (documentId === data.documentId) void navigateToBlock(recordId);
		}}
	/>
</div>

<!--
	Blocks Canvas (Click anywhere below title to start writing) — deliberately
	edge-to-edge (no shared max-w-3xl/px-6 ancestor) so a full-width block
	(issue #150) can span the whole document canvas; each row applies its own
	max-w-3xl/px-6 individually unless isBlockFullWidth(block) is true. See
	design-system.md's content-column section.
-->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="mt-6 flex min-h-[350px] cursor-text flex-col gap-1 pb-16"
	class:select-none={blockDrag.draggingBlockId !== null}
	data-block-container={data.documentId}
	onclick={(e) => {
		if (e.target === e.currentTarget) {
			if (blocks.length > 0) {
				blockRefs[blocks[blocks.length - 1].id]?.focusEditor(false);
			} else {
				void addBlockAfter();
			}
		}
	}}
>
	{#if blocks.length === 0}
		<button
			type="button"
			onclick={() => void addBlockAfter()}
			class="mx-auto w-full max-w-3xl cursor-text px-6 py-2 text-left text-base font-normal text-muted/60 select-none hover:text-muted"
		>
			Type '/' for commands, or start typing...
		</button>
	{/if}
	{#each blocks as block, index (block.id)}
		{@const ytext = ydoc ? getRecordYText(ydoc, syncedBlockTargetId(block)) : undefined}
		{@const holder = heldByOthers.get(syncedBlockTargetId(block))}
		{@const provenanceRecordId = syncedBlockTargetId(block)}
		{@const provenance = ydoc ? (getRecord(ydoc, provenanceRecordId) ?? block) : block}
		{@const bt = block.blockType ?? 'paragraph'}
		{@const syncLocations = ydoc ? syncGroupLocations(provenanceRecordId, block.id) : []}

		{#snippet customContent()}
			{#if bt === 'callout'}
				{#if ydoc}
					<CalloutBlock {block} {ydoc}>
						{#if ytext}
							<BlockEditor
								bind:this={blockRefs[block.id]}
								{ytext}
								recordId={block.id}
								{linkTargets}
								placeholder="Callout note…"
								onInputText={() => handleBlockInput(block.id, provenanceRecordId)}
								onEnter={(caretOffset) => handleEnter(block, caretOffset)}
								onBackspaceAtStart={() => handleBackspace(block, index)}
								onFocusBlock={() => handleFocusBlock(block.id)}
								onSlashKey={() => openSlashMenu(block.id)}
								onLinkShortcut={() => linkComposer.open(block.id)}
								isFirstBlock={index === 0}
								isLastBlock={index === blocks.length - 1}
								onArrowUpAtStart={(x) => handleArrowUpAtStart(index, x)}
								onArrowDownAtEnd={(x) => handleArrowDownAtEnd(index, x)}
							/>
						{/if}
					</CalloutBlock>
				{/if}
			{:else if bt === 'code'}
				<div class="rounded-md border border-border bg-surface p-3 font-mono text-sm">
					{#if ytext}
						<BlockEditor
							bind:this={blockRefs[block.id]}
							{ytext}
							recordId={block.id}
							{linkTargets}
							class="font-mono text-[13.5px]"
							placeholder="Code snippet…"
							onInputText={() => handleBlockInput(block.id, provenanceRecordId)}
							onEnter={(caretOffset) => handleEnter(block, caretOffset)}
							onBackspaceAtStart={() => handleBackspace(block, index)}
							onFocusBlock={() => handleFocusBlock(block.id)}
							onSlashKey={() => openSlashMenu(block.id)}
							onLinkShortcut={() => linkComposer.open(block.id)}
							isFirstBlock={index === 0}
							isLastBlock={index === blocks.length - 1}
							onArrowUpAtStart={(x) => handleArrowUpAtStart(index, x)}
							onArrowDownAtEnd={(x) => handleArrowDownAtEnd(index, x)}
						/>
					{/if}
				</div>
			{:else if bt === 'table_of_contents'}
				<div class="my-2 rounded-lg border border-border bg-surface/60 p-4">
					<div
						class="flex items-center gap-2 text-xs font-semibold tracking-wider text-muted uppercase"
					>
						<Icon name="toc" size={15} class="text-accent" />
						<span>Table of contents</span>
					</div>
					<div class="mt-2 space-y-1 text-sm">
						{#each headings as h (h.id)}
							{@const level = getHeadingLevel(h.blockType)}
							{@const hText = getHeadingText(h.id)}
							<a
								href="#block-{h.id}"
								class="block text-muted transition-colors hover:text-accent"
								style="padding-left: {(level - 1) * 16}px;"
							>
								{hText || 'Untitled heading'}
							</a>
						{:else}
							<p class="text-xs text-muted italic">Add heading blocks to generate outline.</p>
						{/each}
					</div>
				</div>
			{:else if bt === 'synced_block'}
				<div class="rounded-md border border-dashed border-accent/40 bg-surface/30 p-2.5">
					<div class="mb-1 flex items-center justify-between gap-2 text-[11px] text-muted">
						<span class="flex items-center gap-1 font-medium text-accent">
							<Icon name="sync" size={13} />
							<span>Synced Block</span>
						</span>
						<div class="flex items-center gap-2">
							{#if syncLocations.length > 0}
								<SyncedBlockUsage
									spaceId={page.params.spaceId!}
									currentDocumentId={data.documentId}
									instances={syncLocations}
									onJumpTo={(documentId, recordId) => {
										if (documentId === data.documentId) void navigateToBlock(recordId);
									}}
									onDetach={() => handleDetachSyncedBlock(block.id)}
								/>
							{:else if block.referencedRecordId}
								<button
									type="button"
									onclick={() => handleDetachSyncedBlock(block.id)}
									class="flex items-center gap-1 hover:text-accent hover:underline"
								>
									<Icon name="unlink" size={12} />
									<span>Detach</span>
								</button>
							{/if}
							<button
								type="button"
								onclick={() => handleLinkSyncedBlock(block.id)}
								class="hover:text-accent hover:underline"
							>
								{block.referencedRecordId
									? `ID: ${block.referencedRecordId.slice(0, 8)}…`
									: 'Set target ID'}
							</button>
						</div>
					</div>
					{#if ytext}
						<BlockEditor
							bind:this={blockRefs[block.id]}
							{ytext}
							recordId={block.id}
							{linkTargets}
							placeholder="Synced content…"
							onInputText={() => handleBlockInput(block.id, provenanceRecordId)}
							onEnter={() => addBlockAfter(block.id)}
							onBackspaceAtStart={() => handleBackspace(block, index)}
							onFocusBlock={() => handleFocusBlock(block.id, provenanceRecordId)}
							onSlashKey={() => {}}
							onLinkShortcut={() => linkComposer.open(block.id)}
							isFirstBlock={index === 0}
							isLastBlock={index === blocks.length - 1}
							onArrowUpAtStart={(x) => handleArrowUpAtStart(index, x)}
							onArrowDownAtEnd={(x) => handleArrowDownAtEnd(index, x)}
						/>
					{:else}
						<p class="text-xs text-muted italic">
							Click 'Set target ID' to sync with an existing block record.
						</p>
					{/if}
				</div>
			{:else if bt === 'page_link'}
				{@const linkedDoc = block.referencedRecordId
					? documentMetadataById.get(block.referencedRecordId)
					: undefined}
				{@const isBroken = !!block.referencedRecordId && !linkedDoc}
				<div class="my-1 rounded-lg border border-border bg-surface/50 p-2.5 shadow-xs">
					{#if linkedDoc}
						<div class="flex items-center justify-between">
							<a
								href={resolve('/space/[spaceId]/doc/[id]', {
									spaceId: page.params.spaceId!,
									id: linkedDoc.id
								})}
								class="flex items-center gap-2 text-sm font-medium text-fg transition-colors hover:text-accent"
							>
								<Icon name="document" size={16} class="flex-shrink-0 text-accent" />
								<span class="underline underline-offset-2"
									>{linkedDoc.title || 'Untitled Document'}</span
								>
							</a>
							<select
								class="rounded border border-border bg-bg px-2 py-1 text-xs text-fg focus:border-accent"
								aria-label="Change target document"
								value={linkedDoc.id}
								onchange={(event) =>
									setRecordReferencedId(
										ydoc!,
										block.id,
										(event.target as HTMLSelectElement).value,
										CURRENT_USER
									)}
							>
								{#each data.documents as document (document.id)}
									{#if document.id !== data.documentId}
										<option value={document.id}>{documentLocation(document.id)}</option>
									{/if}
								{/each}
							</select>
						</div>
					{:else if isBroken}
						<div class="flex items-center justify-between" role="alert">
							<span class="flex items-center gap-2 text-sm text-muted italic">
								<Icon name="link" size={16} class="flex-shrink-0 opacity-50" />
								Linked page was deleted
							</span>
							<select
								class="rounded border border-border bg-bg px-2 py-1 text-xs text-fg focus:border-accent"
								aria-label="Choose replacement document"
								onchange={(event) => {
									const value = (event.target as HTMLSelectElement).value;
									if (value) setRecordReferencedId(ydoc!, block.id, value, CURRENT_USER);
								}}
							>
								<option value="">Choose a document…</option>
								{#each data.documents as document (document.id)}
									{#if document.id !== data.documentId}
										<option value={document.id}>{documentLocation(document.id)}</option>
									{/if}
								{/each}
							</select>
						</div>
					{:else}
						<div class="flex items-center gap-2 text-xs text-muted">
							<Icon name="link" size={15} class="flex-shrink-0 text-accent" />
							<span>Link to page:</span>
							{#if ydoc}
								<select
									onchange={(e) => {
										const val = (e.target as HTMLSelectElement).value;
										if (val) setRecordReferencedId(ydoc!, block.id, val, CURRENT_USER);
									}}
									class="rounded border border-border bg-bg px-2 py-1 text-xs text-fg focus:border-accent"
								>
									<option value="">Select document…</option>
									{#each data.documents as d (d.id)}
										{#if d.id !== data.documentId}
											<option value={d.id}>{documentLocation(d.id)}</option>
										{/if}
									{/each}
								</select>
							{/if}
						</div>
					{/if}
				</div>
			{:else if bt === 'collection_view'}
				{#if ydoc}
					<CollectionViewBlock {block} {ydoc} collections={data.collections} />
				{/if}
			{:else if bt === 'child_pages'}
				{#if ydoc}
					<ChildPagesBlock
						{block}
						{ydoc}
						documents={data.documents}
						currentDocumentId={data.documentId}
					/>
				{/if}
			{:else if bt === 'columns'}
				{#if ydoc}
					<ColumnsBlock
						{block}
						{ydoc}
						{linkTargets}
						{blockRefs}
						draggingBlockId={blockDrag.draggingBlockId}
						dropIndicatorParentId={blockDrag.dropIndicatorParentId}
						dropIndicatorIndex={blockDrag.dropIndicatorIndex}
						selectedBlockIds={blockSelection.ids}
						{justNavigatedBlockId}
						convertOptions={COLUMN_CONVERTIBLE_BLOCK_TYPES}
						onFocusBlock={(blockId) => handleFocusBlock(blockId)}
						onInputText={(blockId) => handleBlockInput(blockId)}
						onDragHandlePointerDown={(e, blockId, parentId, blockIndex) =>
							blockDrag.startBlockDrag(e, blockId, parentId, blockIndex)}
						onDragHandleKeydown={blockDrag.handleDragHandleKeydown}
						onDuplicateBlock={duplicateBlock}
						onDeleteBlock={deleteBlockViaMenu}
						onConvertBlock={convertBlockViaMenu}
						onCopyBlockLink={copyBlockLink}
						onMoveBlockUp={(blockId) => blockDrag.moveBlock(blockId, 'up')}
						onMoveBlockDown={(blockId) => blockDrag.moveBlock(blockId, 'down')}
					/>
				{/if}
			{/if}
		{/snippet}

		{#snippet trailingContent()}
			{#if bt !== 'synced_block' && syncLocations.length > 0}
				<div class="ml-3 flex flex-shrink-0 items-center gap-1 self-center text-accent">
					<Icon name="sync" size={12} />
					<SyncedBlockUsage
						spaceId={page.params.spaceId!}
						currentDocumentId={data.documentId}
						instances={syncLocations}
						onJumpTo={(documentId, recordId) => {
							if (documentId === data.documentId) void navigateToBlock(recordId);
						}}
					/>
				</div>
			{/if}

			{#if hasProvenance(provenance)}
				<a
					href="{resolve('/audit')}?targetRecordId={encodeURIComponent(provenance.id)}"
					class="ml-3 flex-shrink-0 self-center text-[11px] text-muted/70 underline-offset-2 hover:text-accent hover:underline focus-visible:text-accent focus-visible:underline"
					aria-label="Last edited by {formatActor(provenance.lastEditedBy)} at {formatTimestamp(
						provenance.lastEditedAt
					)}. Open audit history for this block."
				>
					{formatActor(provenance.lastEditedBy)} · {formatTimestamp(provenance.lastEditedAt)}
				</a>
			{:else}
				<span class="ml-3 flex-shrink-0 self-center text-[11px] text-muted/70">
					Editing history unavailable
				</span>
			{/if}
		{/snippet}

		{#snippet insideContent()}
			{#if slashMenuBlockId === block.id}
				<SlashMenu
					query={slashQuery}
					onSelect={(newType) => selectSlashCommand(block.id, newType)}
					onClose={() => (slashMenuBlockId = null)}
				/>
			{/if}
		{/snippet}

		{#if blockDrag.draggingBlockId && blockDrag.dropIndicatorParentId === data.documentId && blockDrag.dropIndicatorIndex === index}
			<div class="mx-auto w-full max-w-3xl px-6">
				<div class="drop-indicator" aria-hidden="true"></div>
			</div>
		{/if}
		<BlockRow
			{block}
			{index}
			siblings={blocks}
			parentId={data.documentId}
			{ydoc}
			{ytext}
			{linkTargets}
			{blockRefs}
			draggingBlockId={blockDrag.draggingBlockId}
			selectedBlockIds={blockSelection.ids}
			{justNavigatedBlockId}
			convertOptions={CONVERTIBLE_BLOCK_TYPES}
			rowClass="mx-auto flex w-full items-start px-6 py-0.5{isBlockFullWidth(block)
				? ''
				: ' max-w-3xl'}"
			moveAriaLabel="Move block. Drag, or use Arrow Up, Arrow Down, Home, and End. Shift-click, Ctrl-click, or Shift-Arrow to select multiple blocks."
			placeholder={index === 0 ? "Type '/' for commands, or start typing..." : ''}
			heldByActorLabel={holder ? formatActor(holder) : undefined}
			customBlockTypes={BLOCK_ROW_CUSTOM_CONTENT_TYPES}
			{customContent}
			{trailingContent}
			{insideContent}
			onDragHandlePointerDown={blockDrag.startBlockDrag}
			onDragHandleKeydown={blockDrag.handleDragHandleKeydown}
			onDuplicateBlock={duplicateBlock}
			onDeleteBlock={deleteBlockViaMenu}
			onConvertBlock={convertBlockViaMenu}
			onCopyBlockLink={copyBlockLink}
			onMoveBlockUp={(blockId) => blockDrag.moveBlock(blockId, 'up')}
			onMoveBlockDown={(blockId) => blockDrag.moveBlock(blockId, 'down')}
			onFocusBlock={() => handleFocusBlock(block.id)}
			onInputText={() => handleBlockInput(block.id, provenanceRecordId)}
			onEnter={(caretOffset) => handleEnter(block, caretOffset)}
			onBackspaceAtStart={() => handleBackspace(block, index)}
			onSlashKey={() => openSlashMenu(block.id)}
			onLinkShortcut={() => linkComposer.open(block.id)}
			onArrowUpAtStart={(x) => handleArrowUpAtStart(index, x)}
			onArrowDownAtEnd={(x) => handleArrowDownAtEnd(index, x)}
			onToggleCollapse={toggleCollapseState}
		/>
	{/each}
	{#if blockDrag.draggingBlockId && blockDrag.dropIndicatorParentId === data.documentId && blockDrag.dropIndicatorIndex === blocks.length}
		<div class="mx-auto w-full max-w-3xl px-6">
			<div class="drop-indicator" aria-hidden="true"></div>
		</div>
	{/if}
</div>

<div class="mx-auto max-w-3xl px-6 pb-10">
	<span class="sr-only" aria-live="polite" aria-atomic="true">{provenanceAnnouncement}</span>
	<span class="sr-only" aria-live="polite" aria-atomic="true">{reorderAnnouncement}</span>

	<!-- Add Block Button -->
	<div class="mt-6 flex items-center gap-2">
		<button
			type="button"
			onclick={() => addBlockAfter(blocks.at(-1)?.id)}
			class="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-accent hover:text-accent"
		>
			<Icon name="plus" size={13} />
			<span>Add block</span>
		</button>
	</div>

	<!-- Footer Hint -->
	<footer class="mt-12 border-t border-border pt-4 text-xs text-muted">
		Formatting: <kbd class="rounded bg-surface px-1 py-0.5 font-mono">⌘/Ctrl+B</kbd> bold ·
		<kbd class="rounded bg-surface px-1 py-0.5 font-mono">I</kbd> italic ·
		<kbd class="rounded bg-surface px-1 py-0.5 font-mono">X</kbd> strikethrough ·
		<kbd class="rounded bg-surface px-1 py-0.5 font-mono">E</kbd> code ·
		<kbd class="rounded bg-surface px-1 py-0.5 font-mono">K</kbd> link. Type "/" for slash commands.
	</footer>
</div>

<DocumentOutline
	open={outlineOpen}
	flatBlocks={outlineBlocks}
	{ydoc}
	{activeBlockId}
	onSelect={(blockId) => void navigateToBlock(blockId)}
	onClose={() => (outlineOpen = false)}
/>

{#if blockSelection.ids.size > 0}
	<div
		class="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-bg px-2 py-1.5 shadow-lg ring-1 ring-black/5"
		role="toolbar"
		aria-label="Selected blocks actions"
	>
		<span class="px-2 text-xs font-medium text-muted">{blockSelection.ids.size} selected</span>
		<button
			type="button"
			onclick={blockSelection.duplicateSelection}
			class="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-fg hover:bg-surface"
		>
			<Icon name="duplicate" size={14} />
			Duplicate
		</button>
		<button
			type="button"
			onclick={() => blockSelection.moveAsGroup('up')}
			disabled={!blockSelection.canMoveAsGroup('up')}
			class="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-fg hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
			title={!blockSelection.isContiguous()
				? 'Only a contiguous selection can move as a unit'
				: 'Move up'}
		>
			<Icon name="arrow-up" size={14} />
			Move up
		</button>
		<button
			type="button"
			onclick={() => blockSelection.moveAsGroup('down')}
			disabled={!blockSelection.canMoveAsGroup('down')}
			class="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-fg hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
			title={!blockSelection.isContiguous()
				? 'Only a contiguous selection can move as a unit'
				: 'Move down'}
		>
			<Icon name="arrow-down" size={14} />
			Move down
		</button>
		<button
			type="button"
			onclick={blockSelection.deleteSelection}
			class="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
		>
			<Icon name="trash" size={14} />
			Delete
		</button>
		<button
			type="button"
			onclick={blockSelection.clear}
			class="ml-1 rounded-md p-1 text-muted hover:bg-surface hover:text-fg"
			aria-label="Clear selection"
		>
			<Icon name="close" size={14} />
		</button>
	</div>
{/if}

<PromptDialog
	open={syncedBlockDialogId !== null}
	title="Set synced block target"
	label="Block record ID"
	placeholder="Paste a block record ID"
	submitLabel="Set target"
	onSubmit={(value) => {
		if (ydoc && syncedBlockDialogId && value.trim()) {
			setRecordReferencedId(ydoc, syncedBlockDialogId, value.trim(), CURRENT_USER);
		}
		syncedBlockDialogId = null;
	}}
	onCancel={() => (syncedBlockDialogId = null)}
/>

<LinkComposerDialog
	composer={linkComposer}
	documents={data.documents}
	collections={data.collections}
	currentDocumentId={data.documentId}
	{documentLocation}
	onApply={applyLink}
/>

<style>
	.drop-indicator {
		height: 2px;
		margin: 2px 0;
		border-radius: 1px;
		background: var(--color-accent);
	}
</style>
