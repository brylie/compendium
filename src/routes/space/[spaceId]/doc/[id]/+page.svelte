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
		moveRecordToParent,
		parentKindOf,
		reorderRecord,
		setBlockType,
		setRecordChecked,
		setRecordCollapsed,
		setRecordReferencedId,
		touchRecordEditor
	} from '$lib/data/record-ops';
	import {
		listSyncedBlockInstances,
		RECORD_LINK_SCHEME,
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
	import {
		columnChildBlockTypes,
		type ActorId,
		type BlockType,
		type TextMarks,
		type WorkspaceRecord
	} from '$lib/data/types';
	import BlockEditor from '$lib/components/BlockEditor.svelte';
	import SlashMenu from './SlashMenu.svelte';
	import Toolbar from './Toolbar.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import CollectionViewBlock from '$lib/components/CollectionViewBlock.svelte';
	import CalloutBlock from '$lib/components/CalloutBlock.svelte';
	import ChildPagesBlock from '$lib/components/ChildPagesBlock.svelte';
	import ColumnsBlock from '$lib/components/ColumnsBlock.svelte';
	import PromptDialog from '$lib/components/PromptDialog.svelte';
	import BlockActionMenu from '$lib/components/BlockActionMenu.svelte';
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
	let linkDialogBlockId: string | null = $state(null);
	let linkMode: 'url' | 'record' = $state('url');
	let linkUrl = $state('');
	let linkRecordId = $state('');
	let linkSelection: { start: number; end: number } | null = $state(null);
	let linkUrlInput: HTMLInputElement | undefined = $state();
	let linkDialog: HTMLDivElement | undefined = $state();
	let provenanceAnnouncement = $state('');
	let provenanceAnnouncementTimer: ReturnType<typeof setTimeout> | undefined;
	let draggingBlockId: string | null = $state(null);
	let dropIndicatorIndex: number | null = $state(null);
	// Which container (the Document, or a column, issue #148) the drop
	// indicator above currently belongs to — a plain index alone is
	// ambiguous once more than one block list is on screen at once.
	let dropIndicatorParentId: string | null = $state(null);
	let reorderAnnouncement = $state('');

	// Multi-select (issue #152) — a set of block ids, always siblings of one
	// another within the same parent container (the Document's own top level,
	// or one column). selectionAnchorId is the fixed end of a Shift-click/
	// Shift-Arrow range; the other end is whatever block was just interacted
	// with. Selecting in a different container replaces the set outright
	// rather than mixing containers — group move/delete below assume a single
	// shared parent.
	const selectedBlockIds = new SvelteSet<string>();
	let selectionAnchorId: string | null = $state(null);
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

	interface BlockEditorHandle {
		render: () => void;
		applyFormat: (mark: keyof TextMarks, value?: unknown) => void;
		applyFormatAtRange: (
			mark: keyof TextMarks,
			range: { start: number; end: number },
			value?: unknown
		) => void;
		getSelectionRange: () => { start: number; end: number } | null;
		getFormatState: () => Partial<Record<keyof TextMarks, boolean>>;
		focusEditor: (position?: boolean | number) => void;
		focusEditorAtLine: (edge: 'first' | 'last', clientX: number | null) => void;
	}

	let blockRefs: Record<string, BlockEditorHandle | undefined> = $state({});

	function refresh(): void {
		if (!ydoc) return;
		const nextBlocks = listRecordsForParent(ydoc, data.documentId);
		blocks = nextBlocks;
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
			openLinkComposer(activeBlockId!);
		} else {
			editor.applyFormat(mark);
		}
		activeMarks = editor.getFormatState();
	}

	function openLinkComposer(blockId: string): void {
		const selection = blockRefs[blockId]?.getSelectionRange();
		if (!selection || selection.start === selection.end) return;
		linkDialogBlockId = blockId;
		linkSelection = selection;
		linkMode = 'url';
		linkUrl = '';
		linkRecordId = '';
	}

	function applyLink(): void {
		const editor = linkDialogBlockId ? blockRefs[linkDialogBlockId] : undefined;
		const value = linkMode === 'record' ? linkRecordId : linkUrl.trim();
		if (!editor || !value || !linkSelection) return;
		editor.applyFormatAtRange(
			'link',
			linkSelection,
			linkMode === 'record' ? `${RECORD_LINK_SCHEME}${value}` : value
		);
		activeMarks = editor.getFormatState();
		closeLinkComposer();
	}

	function closeLinkComposer(): void {
		const blockId = linkDialogBlockId;
		linkDialogBlockId = null;
		linkSelection = null;
		if (blockId) void tick().then(() => blockRefs[blockId]?.focusEditor(false));
	}

	function handleLinkDialogKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			closeLinkComposer();
			return;
		}
		if (event.key !== 'Tab' || !linkDialog) return;
		const focusable = Array.from(
			linkDialog.querySelectorAll<HTMLElement>(
				'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href]'
			)
		);
		const first = focusable[0];
		const last = focusable.at(-1);
		if (!first || !last) return;
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
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
		clearSelection();

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
		if (event.key === 'Escape' && selectedBlockIds.size > 0) {
			clearSelection();
		}
	}

	$effect(() => {
		if (!linkDialogBlockId || linkMode !== 'url') return;
		void tick().then(() => linkUrlInput?.focus());
	});

	// Guards against a leaked window listener if this page unmounts mid-drag
	// (e.g. client-side navigation away while a pointer is still down).
	$effect(() => {
		return () => cleanupDragListeners();
	});

	// Deep-link support for "Copy link to block" (issue #152) — once this
	// Document's blocks have actually loaded, a `#block-<id>` URL fragment
	// scrolls to and focuses that block the same way a List View click does.
	// Guarded per documentId so it fires once per navigation, not on every
	// subsequent blocks refresh (any later edit anywhere in the Document also
	// reassigns `blocks`, which would otherwise re-trigger this on every
	// keystroke).
	let hashNavigatedForDocument: string | null = $state(null);
	$effect(() => {
		if (!ydoc || blocks.length === 0) return;
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
	// But a column only holds the curated columnChildBlockTypes subset
	// (issue #148, see services/records.ts's own creation-time validation) —
	// inserting an unsupported structural type (table, embed, ...) while a
	// column's block is active instead escalates to right after the
	// enclosing columns block itself, at the Document's top level, rather
	// than writing a block type ColumnsBlock.svelte has no idea how to
	// render into a column's own recordIds array.
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
		const allowedInColumn: readonly BlockType[] = columnChildBlockTypes;
		if (allowedInColumn.includes(blockType)) return { parentId: active.parentId, afterId };
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
	const STRUCTURAL_BLOCK_TYPES: readonly BlockType[] = [
		'divider',
		'table',
		'table_of_contents',
		'page_link',
		'embed',
		'synced_block',
		'collection_view',
		'child_pages',
		'columns',
		'column'
	];

	function blockHoldsFreeformText(blockType?: BlockType): boolean {
		return !!blockType && !STRUCTURAL_BLOCK_TYPES.includes(blockType);
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

	// ---------------------------------------------------------------------
	// Block reordering (#40) — a visible move handle in each block's gutter,
	// draggable with the pointer or operable with the keyboard once focused.
	// Both paths end up calling reorderRecord (same container) or
	// moveRecordToParent (a different container — issue #148's move a block
	// into/out of a column), which only ever reposition/reparent a block —
	// content, blockType, and provenance are never touched by either.
	//
	// Every block list on the page (the Document's own top-level flow, and
	// each column inside a columns block) tags its rows with data-block-row
	// + data-block-parent, and its own wrapper with data-block-container, so
	// the pointer-drag geometry below can resolve a drop target across all
	// of them uniformly rather than assuming a single flat list.
	// ---------------------------------------------------------------------

	function announceBlockMoved(newIndex: number, parentId: string, location?: string): void {
		if (!ydoc) return;
		const total = listRecordsForParent(ydoc, parentId).length;
		const suffix = location ? ` in ${location}` : '';
		reorderAnnouncement = `Moved block to position ${newIndex + 1} of ${total}${suffix}.`;
	}

	async function focusDragHandle(blockId: string): Promise<void> {
		await tick();
		document.querySelector<HTMLElement>(`[data-drag-handle="${CSS.escape(blockId)}"]`)?.focus();
	}

	// Resolves what "up"/"down"/"start"/"end" means in terms of
	// reorderRecord's own afterRecordId semantics — split out from moveBlock
	// below purely to keep each function's branching within the cognitive
	// complexity budget; sequential early-return `if`s (not else-if) here
	// avoid the nesting penalty an else-if chain would add.
	function computeMoveTarget(
		siblings: WorkspaceRecord[],
		target: 'up' | 'down' | 'start' | 'end',
		currentIndex: number,
		lastIndex: number
	): { afterRecordId: string | undefined; newIndex: number } | null {
		if (target === 'start') {
			if (currentIndex === 0) return null;
			return { afterRecordId: undefined, newIndex: 0 };
		}
		if (target === 'end') {
			if (currentIndex === lastIndex) return null;
			return { afterRecordId: siblings[lastIndex].id, newIndex: lastIndex };
		}
		if (target === 'up') {
			if (currentIndex === 0) return null;
			const afterRecordId = currentIndex >= 2 ? siblings[currentIndex - 2].id : undefined;
			return { afterRecordId, newIndex: currentIndex - 1 };
		}
		if (currentIndex === lastIndex) return null;
		return { afterRecordId: siblings[currentIndex + 1].id, newIndex: currentIndex + 1 };
	}

	// Keyboard equivalent of dragging: an adjacent swap with the previous/next
	// sibling within the block's own current container, or a direct move to
	// the very start/end of that same container — reusing reorderRecord's
	// own afterRecordId semantics rather than the pointer-drag path's
	// index-into-the-original-list math below, since "swap with my neighbor"
	// is simpler to express directly. Not container-crossing — see
	// moveBlockToAdjacentColumn for that (bound to ArrowLeft/ArrowRight).
	function moveBlock(blockId: string, target: 'up' | 'down' | 'start' | 'end'): void {
		if (!ydoc) return;
		const record = getRecord(ydoc, blockId);
		if (!record) return;
		const siblings = listRecordsForParent(ydoc, record.parentId);
		const currentIndex = siblings.findIndex((b) => b.id === blockId);
		if (currentIndex === -1) return;
		const move = computeMoveTarget(siblings, target, currentIndex, siblings.length - 1);
		if (!move) return;

		reorderRecord(ydoc, blockId, move.afterRecordId);
		announceBlockMoved(move.newIndex, record.parentId);
		void focusDragHandle(blockId);
	}

	// Moves a block sideways into the previous/next column of the same
	// columns block (issue #148) — the keyboard counterpart to dragging a
	// block across columns. A no-op when the block isn't currently inside a
	// column, or there's no column in that direction. Lands at the same
	// index (clamped) in the destination column, rather than always at its
	// start/end, so repeated presses read as "shift sideways," not "jump to
	// an end."
	function moveBlockToAdjacentColumn(blockId: string, direction: 'previous' | 'next'): void {
		if (!ydoc) return;
		const record = getRecord(ydoc, blockId);
		if (!record) return;
		const column = getRecord(ydoc, record.parentId);
		if (column?.blockType !== 'column') return;
		const columnsBlock = getRecord(ydoc, column.parentId);
		if (columnsBlock?.blockType !== 'columns') return;

		const siblingColumns = listRecordsForParent(ydoc, columnsBlock.id);
		const columnIndex = siblingColumns.findIndex((c) => c.id === column.id);
		const targetColumn =
			siblingColumns[direction === 'previous' ? columnIndex - 1 : columnIndex + 1];
		if (!targetColumn) return;

		const positionInColumn = listRecordsForParent(ydoc, column.id).findIndex(
			(b) => b.id === blockId
		);
		const targetSiblings = listRecordsForParent(ydoc, targetColumn.id);
		const insertIndex = Math.min(positionInColumn, targetSiblings.length);
		const afterRecordId = insertIndex > 0 ? targetSiblings[insertIndex - 1]?.id : undefined;

		moveRecordToParent(ydoc, blockId, targetColumn.id, afterRecordId);
		const targetColumnIndex = siblingColumns.findIndex((c) => c.id === targetColumn.id);
		announceBlockMoved(
			insertIndex,
			targetColumn.id,
			`column ${targetColumnIndex + 1} of ${siblingColumns.length}`
		);
		void focusDragHandle(blockId);
	}

	// The plain-move-key branch of handleDragHandleKeydown, split out purely to
	// keep that function's own cognitive complexity within budget — this
	// function assumes no modifier keys are held (its caller already checked).
	function handleDragHandleMoveKey(event: KeyboardEvent, blockId: string): void {
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			moveBlock(blockId, 'up');
		} else if (event.key === 'ArrowDown') {
			event.preventDefault();
			moveBlock(blockId, 'down');
		} else if (event.key === 'Home') {
			event.preventDefault();
			moveBlock(blockId, 'start');
		} else if (event.key === 'End') {
			event.preventDefault();
			moveBlock(blockId, 'end');
		} else if (event.key === 'ArrowLeft') {
			event.preventDefault();
			moveBlockToAdjacentColumn(blockId, 'previous');
		} else if (event.key === 'ArrowRight') {
			event.preventDefault();
			moveBlockToAdjacentColumn(blockId, 'next');
		} else if (event.key === 'Escape' && selectedBlockIds.size > 0) {
			event.preventDefault();
			clearSelection();
		}
	}

	function handleDragHandleKeydown(event: KeyboardEvent, blockId: string): void {
		// Shift+ArrowUp/Down extends the multi-select range from the current
		// anchor (issue #152) — the keyboard equivalent of Shift-clicking the
		// handle, checked before the plain-move branch below so a held Shift
		// never also triggers a reorder.
		if (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
			if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
				event.preventDefault();
				extendBlockSelectionByKeyboard(blockId, event.key === 'ArrowUp' ? 'up' : 'down');
			}
			return;
		}
		if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
		handleDragHandleMoveKey(event, blockId);
	}

	// ---------------------------------------------------------------------
	// Multi-select and group actions (issue #152) — Shift/Ctrl-click (or
	// Shift+Arrow) on a block's move handle builds a set of block ids, always
	// scoped to one parent container (the Document's own top level, or a
	// single column); selecting in a different container replaces the set
	// rather than mixing containers, since group move below assumes one
	// shared, orderable sibling list. The bulk action bar (rendered near the
	// bottom of the template) is the primary UI for acting on the set; it's a
	// plain, Tab-reachable toolbar, so no separate keyboard path is needed for
	// duplicate/delete/move-as-group beyond what already reaches those
	// buttons.
	// ---------------------------------------------------------------------

	function clearSelection(): void {
		selectedBlockIds.clear();
		selectionAnchorId = null;
	}

	function toggleBlockSelection(blockId: string, parentId: string): void {
		// Starting a fresh toggle-select in a different container than the
		// current selection replaces it outright — see the comment above.
		if (!sameContainerSelection(parentId)) selectedBlockIds.clear();
		if (selectedBlockIds.has(blockId)) selectedBlockIds.delete(blockId);
		else selectedBlockIds.add(blockId);
		selectionAnchorId = blockId;
	}

	function extendBlockSelectionRange(blockId: string, parentId: string, index: number): void {
		if (!ydoc) return;
		const anchorId =
			selectionAnchorId && sameContainerSelection(parentId) ? selectionAnchorId : blockId;
		const siblings = listRecordsForParent(ydoc, parentId);
		const anchorIndex = siblings.findIndex((s) => s.id === anchorId);
		if (anchorIndex === -1) {
			selectedBlockIds.clear();
			selectedBlockIds.add(blockId);
			selectionAnchorId = blockId;
			return;
		}
		const [lo, hi] = anchorIndex <= index ? [anchorIndex, index] : [index, anchorIndex];
		selectedBlockIds.clear();
		for (const sibling of siblings.slice(lo, hi + 1)) selectedBlockIds.add(sibling.id);
		selectionAnchorId = anchorId;
	}

	// True when the current selection (if any) already belongs to `parentId` —
	// an empty selection trivially agrees with any container.
	function sameContainerSelection(parentId: string): boolean {
		if (!ydoc || selectedBlockIds.size === 0) return true;
		const [firstId] = selectedBlockIds;
		return getRecord(ydoc, firstId)?.parentId === parentId;
	}

	function extendBlockSelectionByKeyboard(blockId: string, direction: 'up' | 'down'): void {
		if (!ydoc) return;
		const record = getRecord(ydoc, blockId);
		if (!record) return;
		// Establish the anchor at the block the handle was focused on *before*
		// this keypress — without this, a first Shift+Arrow (no prior
		// selection) would fall through to extendBlockSelectionRange's own
		// "no anchor yet" fallback, which anchors on its `blockId` argument.
		// That argument is the *target* row (siblings[nextIndex] below), so the
		// selection would collapse to that single row instead of spanning from
		// where the user started.
		if (!selectionAnchorId || !sameContainerSelection(record.parentId)) {
			selectionAnchorId = blockId;
		}
		const siblings = listRecordsForParent(ydoc, record.parentId);
		const currentIndex = siblings.findIndex((s) => s.id === blockId);
		if (currentIndex === -1) return;
		const nextIndex =
			direction === 'up'
				? Math.max(0, currentIndex - 1)
				: Math.min(siblings.length - 1, currentIndex + 1);
		extendBlockSelectionRange(siblings[nextIndex].id, record.parentId, nextIndex);
		void focusDragHandle(siblings[nextIndex].id);
	}

	// The selected ids in their actual sibling order — needed so
	// duplicate/delete-as-group act in a stable, predictable order rather than
	// Set insertion order (which toggleBlockSelection's add/remove can scramble
	// relative to document order).
	function orderedSelection(): WorkspaceRecord[] {
		if (!ydoc || selectedBlockIds.size === 0) return [];
		const [firstId] = selectedBlockIds;
		const parentId = getRecord(ydoc, firstId)?.parentId;
		if (!parentId) return [];
		return listRecordsForParent(ydoc, parentId).filter((r) => selectedBlockIds.has(r.id));
	}

	function deleteSelection(): void {
		if (!ydoc) return;
		const ids = orderedSelection().map((r) => r.id);
		if (ids.length === 0) return;
		transactWithOrigin(ydoc, LOCAL_UI_ORIGIN, () => {
			for (const id of ids) deleteRecord(ydoc!, id);
		});
		clearSelection();
	}

	function duplicateSelection(): void {
		if (!ydoc) return;
		const ids = orderedSelection().map((r) => r.id);
		if (ids.length === 0) return;
		const copies = ydoc.transact(() => ids.map((id) => duplicateRecord(ydoc!, id, CURRENT_USER)));
		selectedBlockIds.clear();
		for (const copy of copies) selectedBlockIds.add(copy.id);
		selectionAnchorId = copies[0]?.id ?? null;
	}

	interface SelectionGroupBounds {
		siblings: WorkspaceRecord[];
		groupStart: number;
		groupEnd: number;
	}

	// Resolves the current selection's start/end position within its shared
	// parent's sibling list, or null when the selection is empty, spans an id
	// no longer found there, or isn't contiguous — "move a scattered set up"
	// has no single well-defined result. The one shared definition of "is this
	// selection movable as a unit," used by isSelectionContiguous, the bulk
	// bar's Move up/down disabled state, and moveSelectionAsGroup itself, so
	// the three can't drift out of agreement with each other.
	function resolveSelectionGroupBounds(): SelectionGroupBounds | null {
		if (!ydoc) return null;
		const selected = orderedSelection();
		if (selected.length === 0) return null;
		const siblings = listRecordsForParent(ydoc, selected[0].parentId);
		const indices = selected
			.map((r) => siblings.findIndex((s) => s.id === r.id))
			.filter((i) => i !== -1)
			.sort((a, b) => a - b);
		if (indices.length !== selected.length) return null;
		const groupStart = indices[0];
		const groupEnd = indices[indices.length - 1];
		if (groupEnd - groupStart + 1 !== indices.length) return null; // not contiguous
		return { siblings, groupStart, groupEnd };
	}

	function isSelectionContiguous(): boolean {
		return resolveSelectionGroupBounds() !== null;
	}

	// Whether the bulk bar's Move up/down button should be enabled — false for
	// a non-contiguous selection (see resolveSelectionGroupBounds) and also
	// false right at the container boundary in that direction, so the button
	// can't be clicked to silently do nothing.
	function canMoveSelectionAsGroup(direction: 'up' | 'down'): boolean {
		const bounds = resolveSelectionGroupBounds();
		if (!bounds) return false;
		return direction === 'up'
			? bounds.groupStart > 0
			: bounds.groupEnd < bounds.siblings.length - 1;
	}

	// Moves the whole selected group up/down by one position as a unit,
	// swapping it with its one adjacent unselected neighbor — the natural
	// generalization of moveBlock's own single-block adjacent swap.
	function moveSelectionAsGroup(direction: 'up' | 'down'): void {
		if (!ydoc || !canMoveSelectionAsGroup(direction)) return;
		const { siblings, groupStart, groupEnd } = resolveSelectionGroupBounds()!;

		ydoc.transact(() => {
			if (direction === 'up') {
				reorderRecord(ydoc!, siblings[groupStart - 1].id, siblings[groupEnd].id);
			} else {
				const beforeFirst = groupStart > 0 ? siblings[groupStart - 1].id : undefined;
				reorderRecord(ydoc!, siblings[groupEnd + 1].id, beforeFirst);
			}
		});
		const count = groupEnd - groupStart + 1;
		const newStart = direction === 'up' ? groupStart - 1 : groupStart + 1;
		reorderAnnouncement =
			count === 1
				? `Moved block to position ${newStart + 1} of ${siblings.length}.`
				: `Moved ${count} blocks to positions ${newStart + 1}-${newStart + count} of ${siblings.length}.`;
	}

	// Every drop container currently on screen (the Document's own top-level
	// flow, plus one per column) and its bounding rect.
	function containerRectsOnScreen(): { parentId: string; rect: DOMRect }[] {
		return Array.from(document.querySelectorAll<HTMLElement>('[data-block-container]')).map(
			(el) => ({
				parentId: el.dataset.blockContainer!,
				rect: el.getBoundingClientRect()
			})
		);
	}

	// Resolves which container a drag point is currently over. A column's
	// own container rect is nested inside the Document's top-level one, so
	// when a point falls inside more than one, the smallest (most specific)
	// container wins — otherwise a drag over a column would always resolve
	// to the whole page instead.
	function resolveDropContainer(
		clientX: number,
		clientY: number,
		fallbackParentId: string
	): string {
		const hits = containerRectsOnScreen().filter(
			(c) =>
				clientX >= c.rect.left &&
				clientX <= c.rect.right &&
				clientY >= c.rect.top &&
				clientY <= c.rect.bottom
		);
		if (hits.length === 0) return fallbackParentId;
		hits.sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height);
		return hits[0].parentId;
	}

	// Finds the boundary between rendered block rows (within one container)
	// closest to clientY, as an index into that container's *current*
	// (pre-move) sibling array — 0..siblings.length, where siblings.length
	// means "after the last block."
	function dropIndexInContainer(parentId: string, clientY: number): number {
		const rows = Array.from(
			document.querySelectorAll<HTMLElement>(
				`[data-block-row][data-block-parent="${CSS.escape(parentId)}"]`
			)
		);
		for (let i = 0; i < rows.length; i++) {
			const rect = rows[i].getBoundingClientRect();
			if (clientY < rect.top + rect.height / 2) return i;
		}
		return rows.length;
	}

	// targetIndex is a drop-indicator position computed against targetParentId's
	// *current* siblings (still including blockId at its old slot, if it was
	// already there) — translated here into reorderRecord/moveRecordToParent's
	// afterRecordId (resolved among blockId's prospective siblings, i.e. that
	// same array *without* blockId).
	function moveBlockToContainerIndex(
		blockId: string,
		targetParentId: string,
		targetIndex: number
	): void {
		if (!ydoc) return;
		const record = getRecord(ydoc, blockId);
		if (!record) return;

		if (record.parentId === targetParentId) {
			const siblings = listRecordsForParent(ydoc, targetParentId);
			const currentIndex = siblings.findIndex((b) => b.id === blockId);
			if (currentIndex === -1) return;
			const adjusted = targetIndex > currentIndex ? targetIndex - 1 : targetIndex;
			if (adjusted === currentIndex) return; // dropped back at its own position
			const withoutSelf = siblings.filter((b) => b.id !== blockId);
			const afterRecordId = adjusted > 0 ? withoutSelf[adjusted - 1]?.id : undefined;
			reorderRecord(ydoc, blockId, afterRecordId);
			announceBlockMoved(adjusted, targetParentId);
			return;
		}

		// Cross-container move (issue #148) — into/out of a column. Dropping
		// into a column is restricted to the same curated
		// columnChildBlockTypes set create_record enforces at creation time
		// (services/records.ts) — the drag path bypasses that service-layer
		// check entirely (a direct data-layer call, like every other UI
		// mutation), so it needs its own guard here or an unsupported type
		// (e.g. a table or another columns block) could be dropped into a
		// column with nothing to render it.
		const targetContainer = getRecord(ydoc, targetParentId);
		if (targetContainer?.blockType === 'column') {
			const allowed: readonly BlockType[] = columnChildBlockTypes;
			if (!allowed.includes(record.blockType ?? 'paragraph')) return;
		}
		const destSiblings = listRecordsForParent(ydoc, targetParentId);
		const afterRecordId = targetIndex > 0 ? destSiblings[targetIndex - 1]?.id : undefined;
		moveRecordToParent(ydoc, blockId, targetParentId, afterRecordId);
		announceBlockMoved(targetIndex, targetParentId);
	}

	function cleanupDragListeners(): void {
		window.removeEventListener('pointermove', handleDragPointerMove);
		window.removeEventListener('pointerup', handleDragPointerUp);
		window.removeEventListener('pointercancel', cancelDrag);
		window.removeEventListener('keydown', handleDragEscapeKeydown);
	}

	function cancelDrag(): void {
		cleanupDragListeners();
		draggingBlockId = null;
		dropIndicatorIndex = null;
		dropIndicatorParentId = null;
	}

	function handleDragPointerMove(event: PointerEvent): void {
		if (!draggingBlockId || !ydoc) return;
		const sourceParentId = getRecord(ydoc, draggingBlockId)?.parentId ?? data.documentId;
		const containerId = resolveDropContainer(event.clientX, event.clientY, sourceParentId);
		dropIndicatorParentId = containerId;
		dropIndicatorIndex = dropIndexInContainer(containerId, event.clientY);
	}

	function handleDragPointerUp(): void {
		const blockId = draggingBlockId;
		const targetParentId = dropIndicatorParentId;
		const targetIndex = dropIndicatorIndex;
		cleanupDragListeners();
		draggingBlockId = null;
		dropIndicatorIndex = null;
		dropIndicatorParentId = null;
		if (blockId !== null && targetParentId !== null && targetIndex !== null) {
			moveBlockToContainerIndex(blockId, targetParentId, targetIndex);
		}
	}

	function handleDragEscapeKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') cancelDrag();
	}

	function startBlockDrag(
		event: PointerEvent,
		blockId: string,
		parentId: string,
		index: number
	): void {
		// Only the primary button/touch starts a drag — a right-click or an
		// auxiliary button on the handle shouldn't hijack a context menu.
		if (event.button !== 0) return;
		// Shift/Ctrl/Cmd-clicking the move handle selects a range/toggles a
		// block instead of dragging it (issue #152 multi-select) — the same
		// modifier-click convention a file manager or spreadsheet uses, chosen
		// specifically so it can't collide with a plain drag-to-reorder click.
		if (event.shiftKey || event.ctrlKey || event.metaKey) {
			event.preventDefault();
			if (event.shiftKey) {
				extendBlockSelectionRange(blockId, parentId, index);
			} else {
				toggleBlockSelection(blockId, parentId);
			}
			return;
		}
		event.preventDefault();
		draggingBlockId = blockId;
		dropIndicatorParentId = parentId;
		dropIndicatorIndex = index;
		window.addEventListener('pointermove', handleDragPointerMove);
		window.addEventListener('pointerup', handleDragPointerUp);
		// The browser can cancel the pointer stream without ever firing
		// pointerup — e.g. a touch drag that turns into a page scroll — which
		// would otherwise leave the drag state (and these listeners) stuck
		// active until an unrelated future pointerup silently commits a
		// reorder the user never asked for.
		window.addEventListener('pointercancel', cancelDrag);
		window.addEventListener('keydown', handleDragEscapeKeydown);
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

	function toggleTodoCheck(block: WorkspaceRecord): void {
		if (!ydoc) return;
		setRecordChecked(ydoc, block.id, !block.checked, CURRENT_USER);
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
	const CONVERTIBLE_BLOCK_TYPES: { type: BlockType; label: string }[] = [
		{ type: 'paragraph', label: 'Text' },
		{ type: 'heading_1', label: 'Heading 1' },
		{ type: 'heading_2', label: 'Heading 2' },
		{ type: 'heading_3', label: 'Heading 3' },
		{ type: 'heading_4', label: 'Heading 4' },
		{ type: 'bulleted_list_item', label: 'Bulleted list' },
		{ type: 'numbered_list_item', label: 'Numbered list' },
		{ type: 'to_do', label: 'To-do' },
		{ type: 'quote', label: 'Quote' },
		{ type: 'callout', label: 'Callout' },
		{ type: 'toggle', label: 'Toggle' },
		{ type: 'code', label: 'Code' }
	];

	function isConvertibleBlockType(blockType?: BlockType): boolean {
		return CONVERTIBLE_BLOCK_TYPES.some((c) => c.type === blockType);
	}

	// A column's own curated child-type subset (data-model.md §3.1) excludes
	// callout/toggle/code entirely, so those three are dropped from the
	// "Convert to" list offered *inside* a column — converting a column's
	// block to one of them would produce a block type that block-capability-
	// contract.md's column-child rule (and services/records.ts's own
	// creation-time validation) doesn't allow there.
	const COLUMN_CONVERTIBLE_BLOCK_TYPES = CONVERTIBLE_BLOCK_TYPES.filter((c) =>
		(columnChildBlockTypes as readonly BlockType[]).includes(c.type)
	);

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
		selectedBlockIds.delete(blockId);
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

	// Same per-block-type dispatch shape as getHeadingLevel above, for the
	// text styling a heading block's own BlockEditor renders with.
	function headingTextClass(blockType?: BlockType): string {
		switch (blockType) {
			case 'heading_1':
				return 'font-display text-2xl font-bold text-fg';
			case 'heading_2':
				return 'font-display text-xl font-semibold text-fg';
			case 'heading_3':
				return 'font-display text-lg font-semibold text-fg';
			case 'heading_4':
				return 'font-display text-base font-semibold text-fg';
			default:
				return 'text-base text-fg';
		}
	}

	// Helper for numbered lists to compute sequential item numbers
	function getNumberedListIndex(currentIndex: number): number {
		let num = 1;
		for (let i = currentIndex - 1; i >= 0; i--) {
			if (blocks[i].blockType === 'numbered_list_item') {
				num++;
			} else {
				break;
			}
		}
		return num;
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
	class:select-none={draggingBlockId !== null}
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

		{#if draggingBlockId && dropIndicatorParentId === data.documentId && dropIndicatorIndex === index}
			<div class="mx-auto w-full max-w-3xl px-6">
				<div class="drop-indicator" aria-hidden="true"></div>
			</div>
		{/if}
		<div
			class="group relative mx-auto flex w-full items-start px-6 py-0.5"
			class:max-w-3xl={!isBlockFullWidth(block)}
			class:opacity-50={draggingBlockId === block.id}
			class:bg-surface={selectedBlockIds.has(block.id)}
			class:rounded={selectedBlockIds.has(block.id) || justNavigatedBlockId === block.id}
			class:outline={justNavigatedBlockId === block.id}
			class:outline-2={justNavigatedBlockId === block.id}
			class:outline-accent={justNavigatedBlockId === block.id}
			id="block-{block.id}"
			data-block-row
			data-block-parent={data.documentId}
		>
			<!-- Move handle: pointer-draggable, or ArrowUp/ArrowDown/Home/End
					 once focused; Shift/Ctrl-click or Shift+Arrow selects a range
					 instead (issue #152) — see the block-reordering/selection
					 functions above. -->
			<button
				type="button"
				class="mt-1 mr-1 flex h-5 w-5 flex-shrink-0 cursor-grab items-center justify-center rounded text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-surface hover:text-fg focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent active:cursor-grabbing"
				aria-label="Move block. Drag, or use Arrow Up, Arrow Down, Home, and End. Shift-click, Ctrl-click, or Shift-Arrow to select multiple blocks."
				data-drag-handle={block.id}
				onpointerdown={(e) => startBlockDrag(e, block.id, data.documentId, index)}
				onkeydown={(e) => handleDragHandleKeydown(e, block.id)}
			>
				<Icon name="grip" size={14} />
			</button>

			<BlockActionMenu
				blockType={block.blockType}
				canMoveUp={index > 0}
				canMoveDown={index < blocks.length - 1}
				isConvertible={isConvertibleBlockType(block.blockType)}
				convertOptions={CONVERTIBLE_BLOCK_TYPES}
				onDuplicate={() => duplicateBlock(block.id)}
				onDelete={() => deleteBlockViaMenu(block.id)}
				onConvert={(blockType) => convertBlockViaMenu(block.id, blockType)}
				onCopyLink={() => copyBlockLink(block.id)}
				onMoveUp={() => moveBlock(block.id, 'up')}
				onMoveDown={() => moveBlock(block.id, 'down')}
			/>

			<!-- Left Indicator / Control Gutter -->
			{#if bt === 'to_do'}
				<button
					type="button"
					onclick={() => toggleTodoCheck(block)}
					class="mt-1 mr-2 flex h-4.5 w-4.5 flex-shrink-0 items-center justify-center rounded border border-border bg-bg text-accent transition-colors hover:border-accent"
					class:bg-accent={block.checked}
					class:border-accent={block.checked}
					title={block.checked ? 'Mark as incomplete' : 'Mark as complete'}
					aria-label={block.checked ? 'Mark as incomplete' : 'Mark as complete'}
				>
					{#if block.checked}
						<Icon name="check" size={13} class="stroke-[2.5] text-accent-fg" />
					{/if}
				</button>
			{:else if bt === 'bulleted_list_item'}
				<span
					class="mt-1 mr-2.5 flex h-4 w-3.5 flex-shrink-0 items-center justify-center font-bold text-muted select-none"
				>
					•
				</span>
			{:else if bt === 'numbered_list_item'}
				<span
					class="mt-1 mr-2 flex w-5 flex-shrink-0 items-center justify-end text-xs font-medium text-muted select-none"
				>
					{getNumberedListIndex(index)}.
				</span>
			{:else if bt === 'toggle'}
				<button
					type="button"
					onclick={() => toggleCollapseState(block)}
					class="mt-1 mr-1 flex h-4.5 w-4.5 flex-shrink-0 items-center justify-center rounded text-muted hover:bg-surface hover:text-fg"
					aria-label={block.collapsed ? 'Expand section' : 'Collapse section'}
				>
					<Icon name={block.collapsed ? 'chevron-right' : 'chevron-down'} size={14} />
				</button>
			{/if}

			<!-- Block Content -->
			<div class="min-w-0 flex-1">
				{#if holder}
					<!-- Held / Placeholder Block (M1 Design System) -->
					<!--
							role="group", not role="status": the persistent live
							region above is the sole announcement source. A
							role="status" here would be a second, independent
							live region — every hold's insertion (and each one's
							text) would announce a second time on top of the
							region's own announcement.
						-->
					<div
						class="flex h-7 items-center gap-2 rounded-md bg-surface/40 px-2 py-1"
						title="{formatActor(holder)} is editing this block"
						role="group"
						aria-label="{formatActor(holder)} is editing this block"
					>
						<span
							class="flex h-4.5 w-4.5 flex-shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-accent-fg"
							aria-hidden="true"
						>
							{formatActor(holder).slice(0, 1).toUpperCase()}
						</span>
						<div class="shimmer-bar h-3 flex-1 rounded bg-surface" aria-hidden="true"></div>
						<span class="text-[11px] font-medium text-muted" aria-hidden="true"
							>{formatActor(holder)} editing…</span
						>
					</div>
				{:else if bt === 'divider'}
					<div class="my-3 border-t border-border"></div>
				{:else if bt === 'callout'}
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
									onLinkShortcut={() => openLinkComposer(block.id)}
									isFirstBlock={index === 0}
									isLastBlock={index === blocks.length - 1}
									onArrowUpAtStart={(x) => handleArrowUpAtStart(index, x)}
									onArrowDownAtEnd={(x) => handleArrowDownAtEnd(index, x)}
								/>
							{/if}
						</CalloutBlock>
					{/if}
				{:else if bt === 'quote'}
					<div class="border-l-2 border-accent/60 py-0.5 pl-3.5 text-fg/90 italic">
						{#if ytext}
							<BlockEditor
								bind:this={blockRefs[block.id]}
								{ytext}
								recordId={block.id}
								{linkTargets}
								placeholder="Quote…"
								onInputText={() => handleBlockInput(block.id, provenanceRecordId)}
								onEnter={(caretOffset) => handleEnter(block, caretOffset)}
								onBackspaceAtStart={() => handleBackspace(block, index)}
								onFocusBlock={() => handleFocusBlock(block.id)}
								onSlashKey={() => {}}
								onLinkShortcut={() => openLinkComposer(block.id)}
								isFirstBlock={index === 0}
								isLastBlock={index === blocks.length - 1}
								onArrowUpAtStart={(x) => handleArrowUpAtStart(index, x)}
								onArrowDownAtEnd={(x) => handleArrowDownAtEnd(index, x)}
							/>
						{/if}
					</div>
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
								onLinkShortcut={() => openLinkComposer(block.id)}
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
								onLinkShortcut={() => openLinkComposer(block.id)}
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
							{draggingBlockId}
							{dropIndicatorParentId}
							{dropIndicatorIndex}
							{selectedBlockIds}
							{justNavigatedBlockId}
							convertOptions={COLUMN_CONVERTIBLE_BLOCK_TYPES}
							onFocusBlock={(blockId) => handleFocusBlock(blockId)}
							onInputText={(blockId) => handleBlockInput(blockId)}
							onDragHandlePointerDown={(e, blockId, parentId, blockIndex) =>
								startBlockDrag(e, blockId, parentId, blockIndex)}
							onDragHandleKeydown={handleDragHandleKeydown}
							onDuplicateBlock={duplicateBlock}
							onDeleteBlock={deleteBlockViaMenu}
							onConvertBlock={convertBlockViaMenu}
							onCopyBlockLink={copyBlockLink}
							onMoveBlockUp={(blockId) => moveBlock(blockId, 'up')}
							onMoveBlockDown={(blockId) => moveBlock(blockId, 'down')}
						/>
					{/if}
				{:else}
					<!-- Standard text blocks: headings, paragraph, to_do text, toggle text -->
					{#if ytext}
						<div
							class:line-through={bt === 'to_do' && block.checked}
							class:text-muted={bt === 'to_do' && block.checked}
						>
							<BlockEditor
								bind:this={blockRefs[block.id]}
								{ytext}
								recordId={block.id}
								{linkTargets}
								class={headingTextClass(bt)}
								placeholder={index === 0 ? "Type '/' for commands, or start typing..." : ''}
								onInputText={() => handleBlockInput(block.id, provenanceRecordId)}
								onEnter={(caretOffset) => handleEnter(block, caretOffset)}
								onBackspaceAtStart={() => handleBackspace(block, index)}
								onFocusBlock={() => handleFocusBlock(block.id)}
								onSlashKey={() => openSlashMenu(block.id)}
								onLinkShortcut={() => openLinkComposer(block.id)}
								isFirstBlock={index === 0}
								isLastBlock={index === blocks.length - 1}
								onArrowUpAtStart={(x) => handleArrowUpAtStart(index, x)}
								onArrowDownAtEnd={(x) => handleArrowDownAtEnd(index, x)}
							/>
						</div>
					{/if}
				{/if}

				<!-- Slash Menu Popup -->
				{#if slashMenuBlockId === block.id}
					<SlashMenu
						query={slashQuery}
						onSelect={(newType) => selectSlashCommand(block.id, newType)}
						onClose={() => (slashMenuBlockId = null)}
					/>
				{/if}
			</div>

			<!-- Synced-block source indicator (issue #153): only a plain block
					 that at least one synced_block instance currently mirrors gets
					 this — a distinct treatment from the instance's own dashed-border
					 "Synced Block" card above, so a source is recognizable even
					 though it renders like any other block otherwise. -->
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

			<!-- Provenance comes from the record's live CRDT projection; the link
					 opens the corresponding rows in the shared audit history. -->
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
		</div>
	{/each}
	{#if draggingBlockId && dropIndicatorParentId === data.documentId && dropIndicatorIndex === blocks.length}
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

{#if selectedBlockIds.size > 0}
	<div
		class="fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-bg px-2 py-1.5 shadow-lg ring-1 ring-black/5"
		role="toolbar"
		aria-label="Selected blocks actions"
	>
		<span class="px-2 text-xs font-medium text-muted">{selectedBlockIds.size} selected</span>
		<button
			type="button"
			onclick={duplicateSelection}
			class="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-fg hover:bg-surface"
		>
			<Icon name="duplicate" size={14} />
			Duplicate
		</button>
		<button
			type="button"
			onclick={() => moveSelectionAsGroup('up')}
			disabled={!canMoveSelectionAsGroup('up')}
			class="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-fg hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
			title={!isSelectionContiguous()
				? 'Only a contiguous selection can move as a unit'
				: 'Move up'}
		>
			<Icon name="arrow-up" size={14} />
			Move up
		</button>
		<button
			type="button"
			onclick={() => moveSelectionAsGroup('down')}
			disabled={!canMoveSelectionAsGroup('down')}
			class="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-fg hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
			title={!isSelectionContiguous()
				? 'Only a contiguous selection can move as a unit'
				: 'Move down'}
		>
			<Icon name="arrow-down" size={14} />
			Move down
		</button>
		<button
			type="button"
			onclick={deleteSelection}
			class="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
		>
			<Icon name="trash" size={14} />
			Delete
		</button>
		<button
			type="button"
			onclick={clearSelection}
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

{#if linkDialogBlockId !== null}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
		role="presentation"
	>
		<div
			bind:this={linkDialog}
			role="dialog"
			aria-modal="true"
			aria-labelledby="link-composer-title"
			tabindex="-1"
			class="w-full max-w-md rounded-lg border border-border bg-bg p-5 shadow-xl"
			onkeydown={handleLinkDialogKeydown}
		>
			<h2 id="link-composer-title" class="text-lg font-semibold text-fg">Add link</h2>
			<div class="mt-4 flex gap-2" role="group" aria-label="Link type">
				<button
					type="button"
					onclick={() => (linkMode = 'url')}
					class="rounded px-3 py-1.5 text-sm"
					class:bg-accent={linkMode === 'url'}
					class:text-accent-fg={linkMode === 'url'}
					class:bg-surface={linkMode !== 'url'}>Web address</button
				>
				<button
					type="button"
					onclick={() => (linkMode = 'record')}
					class="rounded px-3 py-1.5 text-sm"
					class:bg-accent={linkMode === 'record'}
					class:text-accent-fg={linkMode === 'record'}
					class:bg-surface={linkMode !== 'record'}>Workspace item</button
				>
			</div>
			{#if linkMode === 'url'}
				<label class="mt-4 block text-sm font-medium text-fg">
					Web address
					<input
						bind:this={linkUrlInput}
						bind:value={linkUrl}
						placeholder="https://example.com"
						class="mt-1.5 w-full rounded border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent"
					/>
				</label>
			{:else}
				<label class="mt-4 block text-sm font-medium text-fg">
					Link to
					<select
						bind:value={linkRecordId}
						class="mt-1.5 w-full rounded border border-border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent"
					>
						<option value="">Choose a page or collection…</option>
						<optgroup label="Pages">
							{#each data.documents as document (document.id)}
								{#if document.id !== data.documentId}
									<option value={document.id}>{documentLocation(document.id)}</option>
								{/if}
							{/each}
						</optgroup>
						<optgroup label="Collections">
							{#each data.collections as collection (collection.id)}
								<option value={collection.id}>{collection.title || 'Untitled collection'}</option>
							{/each}
						</optgroup>
					</select>
				</label>
			{/if}
			<div class="mt-5 flex justify-end gap-2">
				<button
					type="button"
					onclick={closeLinkComposer}
					class="rounded px-3 py-2 text-sm text-muted hover:text-fg">Cancel</button
				>
				<button
					type="button"
					disabled={linkMode === 'url' ? !linkUrl.trim() : !linkRecordId}
					onclick={applyLink}
					class="rounded bg-accent px-3 py-2 text-sm font-medium text-accent-fg disabled:opacity-40"
					>Add link</button
				>
			</div>
		</div>
	</div>
{/if}

<style>
	.drop-indicator {
		height: 2px;
		margin: 2px 0;
		border-radius: 1px;
		background: var(--color-accent);
	}
	.shimmer-bar {
		background: linear-gradient(
			90deg,
			var(--color-surface) 25%,
			var(--color-border) 50%,
			var(--color-surface) 75%
		);
		background-size: 200% 100%;
		animation: shimmer 1.5s ease-in-out infinite;
	}
	@keyframes shimmer {
		0% {
			background-position: 200% 0;
		}
		100% {
			background-position: -200% 0;
		}
	}
</style>
