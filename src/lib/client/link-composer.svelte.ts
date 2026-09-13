import { tick } from 'svelte';
import { RECORD_LINK_SCHEME } from '$lib/data/links';
import type { BlockEditorHandle } from '$lib/components/BlockRow.svelte';

export interface LinkComposer {
	/** The block currently being linked, or null while the dialog is closed. */
	readonly blockId: string | null;
	mode: 'url' | 'record';
	url: string;
	recordId: string;
	/** Opens the composer for `blockId`'s current text selection; a no-op (dialog stays closed) when nothing is selected — a link needs text to attach to. */
	open(blockId: string): void;
	/** Applies the current mode's value as a link over the captured selection, then closes. */
	apply(): void;
	/** Closes the dialog and returns focus to the block it was opened for. */
	close(): void;
	/** Escape closes; Tab/Shift+Tab wrap focus within `dialogEl` (a plain modal focus trap). */
	handleKeydown(event: KeyboardEvent, dialogEl: HTMLElement | undefined): void;
}

/**
 * Owns the Document editor's link-composer dialog state (issue #241) — which
 * block/selection it targets, the URL-vs-workspace-item mode, and the two
 * modes' input values — so `+page.svelte` only needs to call `open`/`apply`/
 * `close` and render `LinkComposerDialog.svelte` against this object.
 */
export function createLinkComposer(
	getEditor: (blockId: string) => BlockEditorHandle | undefined
): LinkComposer {
	let blockId: string | null = $state(null);
	let mode: 'url' | 'record' = $state('url');
	let url = $state('');
	let recordId = $state('');
	let selection: { start: number; end: number } | null = null;

	function open(id: string): void {
		const sel = getEditor(id)?.getSelectionRange();
		if (!sel || sel.start === sel.end) return;
		blockId = id;
		selection = sel;
		mode = 'url';
		url = '';
		recordId = '';
	}

	function apply(): void {
		const editor = blockId ? getEditor(blockId) : undefined;
		const value = mode === 'record' ? recordId : url.trim();
		if (!editor || !value || !selection) return;
		editor.applyFormatAtRange(
			'link',
			selection,
			mode === 'record' ? `${RECORD_LINK_SCHEME}${value}` : value
		);
		close();
	}

	function close(): void {
		const closingBlockId = blockId;
		blockId = null;
		selection = null;
		if (closingBlockId) void tick().then(() => getEditor(closingBlockId)?.focusEditor(false));
	}

	function handleKeydown(event: KeyboardEvent, dialogEl: HTMLElement | undefined): void {
		if (event.key === 'Escape') {
			close();
			return;
		}
		if (event.key !== 'Tab' || !dialogEl) return;
		const focusable = Array.from(
			dialogEl.querySelectorAll<HTMLElement>(
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

	return {
		get blockId() {
			return blockId;
		},
		get mode() {
			return mode;
		},
		set mode(v) {
			mode = v;
		},
		get url() {
			return url;
		},
		set url(v) {
			url = v;
		},
		get recordId() {
			return recordId;
		},
		set recordId(v) {
			recordId = v;
		},
		open,
		apply,
		close,
		handleKeydown
	};
}
