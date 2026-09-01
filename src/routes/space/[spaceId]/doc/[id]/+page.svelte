<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { getShardAwareness, getShardDoc } from '$lib/client/yjs-client';
	import { CURRENT_USER } from '$lib/client/actor';
	import {
		createRecord,
		deleteRecord,
		getDocument,
		getRecord,
		getRecordYText,
		listRecordsForParent,
		setBlockType,
		setRecordChecked,
		setRecordCollapsed,
		setRecordReferencedId,
		touchRecordEditor,
		updateDocumentTitle
	} from '$lib/data/records';
	import { RECORD_LINK_SCHEME, type InternalLinkTarget } from '$lib/data/links';
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
	import type { ActorId, BlockType, TextMarks, WorkspaceRecord } from '$lib/data/types';
	import BlockEditor from './BlockEditor.svelte';
	import SlashMenu from './SlashMenu.svelte';
	import Toolbar from './Toolbar.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import CollectionViewBlock from '$lib/components/CollectionViewBlock.svelte';
	import PromptDialog from '$lib/components/PromptDialog.svelte';
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
		const active = activeBlockId ? blocks.find((b) => b.id === activeBlockId) : undefined;
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
		void addBlockAfter(activeBlockId ?? blocks.at(-1)?.id, blockType);
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
			let previousHeldByOthers: Map<string, ActorId> = new Map();
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
		}
	}

	$effect(() => {
		if (!linkDialogBlockId || linkMode !== 'url') return;
		void tick().then(() => linkUrlInput?.focus());
	});

	function handleTitleInput(event: Event): void {
		if (!ydoc) return;
		title = (event.target as HTMLInputElement).value;
		updateDocumentTitle(ydoc, data.documentId, title);
	}

	async function addBlockAfter(
		afterId?: string,
		blockType: BlockType = 'paragraph'
	): Promise<void> {
		if (!ydoc) return;
		const record = createRecord(
			ydoc,
			{ parentId: data.documentId, blockType, afterRecordId: afterId },
			CURRENT_USER
		);
		await tick();
		blockRefs[record.id]?.focusEditor(true);
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
		'collection_view'
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
		const ytext = getRecordYText(ydoc, block.id);
		const richText = ytext ? yTextToRichText(ytext) : { runs: [] };
		const offset = ytext ? Math.min(Math.max(0, caretOffset), ytext.length) : 0;
		const { after } = splitRichTextAt(richText, offset);

		if (ytext && offset < ytext.length) {
			const doc = ytext.doc;
			const trim = () => ytext.delete(offset, ytext.length - offset);
			if (doc) doc.transact(trim);
			else trim();
		}

		const record = createRecord(
			ydoc,
			{ parentId: data.documentId, blockType: nextBlockType, afterRecordId: block.id },
			CURRENT_USER
		);
		if (after.runs.length > 0) {
			const newYtext = getRecordYText(ydoc, record.id);
			if (newYtext) applyRichTextToYText(newYtext, after);
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
		const previous = blocks[index - 1];
		if (!previous) return;

		const currentYtext = getRecordYText(ydoc, block.id);
		const currentIsEmpty = !currentYtext || currentYtext.length === 0;
		const previousHoldsText = blockHoldsFreeformText(previous.blockType);
		if (!currentIsEmpty && !previousHoldsText) return;

		const previousYtext = previousHoldsText ? getRecordYText(ydoc, previous.id) : undefined;
		const joinOffset = previousYtext?.length ?? 0;
		if (!currentIsEmpty && previousYtext && currentYtext) {
			appendRichTextToYText(previousYtext, yTextToRichText(currentYtext));
		}

		deleteRecord(ydoc, block.id);
		await tick();
		blockRefs[previous.id]?.focusEditor(joinOffset);
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
			if (doc) doc.transact(clear);
			else clear();
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

	// Computed heading list for Table of Contents blocks
	let headings = $derived(
		blocks.filter((b) =>
			['heading_1', 'heading_2', 'heading_3', 'heading_4'].includes(b.blockType ?? '')
		)
	);

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
	function syncedBlockTargetId(block: WorkspaceRecord): string {
		return block.blockType === 'synced_block' && block.referencedRecordId
			? block.referencedRecordId
			: block.id;
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

<div class="mx-auto max-w-3xl px-6 py-10">
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
		Backlinks panel removed (#120): listIncomingLinks builds its reverse
		index by scanning every Document within one shared Y.Doc, structurally
		incompatible with per-Document shards. A real workspace-wide backlink
		index is tracked separately as #21 — this panel comes back once that
		exists, rather than being served here via an expensive full-shard scan.
	-->

	<!-- Blocks Canvas (Click anywhere below title to start writing) -->
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="mt-6 flex min-h-[350px] cursor-text flex-col gap-1 pb-16"
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
				class="w-full cursor-text py-2 text-left text-base font-normal text-muted/60 select-none hover:text-muted"
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

			<div class="group relative flex items-start py-0.5" id="block-{block.id}">
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
						<div class="flex gap-3 rounded-lg border border-border bg-surface p-3.5 shadow-xs">
							<Icon name="callout" size={18} class="mt-0.5 flex-shrink-0 text-accent" />
							<div class="min-w-0 flex-1">
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
									/>
								{/if}
							</div>
						</div>
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
							<div class="mb-1 flex items-center justify-between text-[11px] text-muted">
								<span class="flex items-center gap-1 font-medium text-accent">
									<Icon name="sync" size={13} />
									<span>Synced Block</span>
								</span>
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
									onFocusBlock={() =>
										handleFocusBlock(block.id, block.referencedRecordId || block.id)}
									onSlashKey={() => {}}
									onLinkShortcut={() => openLinkComposer(block.id)}
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
	</div>
	<span class="sr-only" aria-live="polite" aria-atomic="true">{provenanceAnnouncement}</span>

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
