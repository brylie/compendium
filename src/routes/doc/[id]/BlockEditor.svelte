<script lang="ts">
	import type * as Y from 'yjs';
	import { diffPlainText } from '$lib/client/text-diff';
	import { getCaretOffset, getSelectionOffsets, setCaretOffset } from '$lib/client/caret';
	import { plainText, yTextToRichText } from '$lib/data/richtext';
	import { RECORD_LINK_SCHEME, type InternalLinkTarget } from '$lib/data/links';
	import type { TextMarks } from '$lib/data/types';

	let {
		ytext,
		recordId = '',
		placeholder = '',
		class: className = '',
		linkTargets,
		onInputText,
		onEnter,
		onBackspaceAtStart,
		onFocusBlock,
		onSlashKey,
		onLinkShortcut = () => {}
	}: {
		ytext: Y.Text;
		recordId?: string;
		placeholder?: string;
		class?: string;
		// Catalog-backed (data.documents + data.collections), not resolved from
		// a live Y.Doc: an inline record: wiki-link's target is very often a
		// *different* Document, which now lives in its own isolated shard
		// (#120) this block's own doc has no connection to. Not live, same
		// accepted tradeoff as every other catalog-backed lookup on this page.
		linkTargets: Map<string, InternalLinkTarget>;
		onInputText: () => void;
		onEnter: (caretOffset: number) => void;
		onBackspaceAtStart: () => void;
		onFocusBlock: () => void;
		onSlashKey: () => void;
		onLinkShortcut?: () => void;
	} = $props();

	let el: HTMLDivElement | undefined = $state();
	let lastPlainText = '';
	let isComposing = false;

	function escapeHtml(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	function safeHref(url: string): string {
		try {
			const parsed = new URL(url, window.location.origin);
			if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return parsed.href;
		} catch {
			// fall through to the inert value below
		}
		return '#';
	}

	// A `record:` scheme link is an internal wiki-link (page_link's inline
	// sibling — see docs/specifications/internal-links.md), not an external
	// URL: it's resolved live against the current Documents/Collections index
	// rather than passed through safeHref, so renaming its target doesn't
	// break it and deleting its target renders as an explicit broken state
	// instead of a silently dead generic link.
	function runToHtml(text: string, marks: TextMarks): string {
		// Resolved up front (not just to decide the branch below) because a
		// live target's *label* must track its current title too — the stored
		// run text is whatever the title was at link-creation time, and a
		// rename since then must not leave the visible label stale even
		// though the href/broken-check already re-resolve live.
		const target = marks.link?.startsWith(RECORD_LINK_SCHEME)
			? linkTargets.get(marks.link.slice(RECORD_LINK_SCHEME.length))
			: undefined;
		let html = escapeHtml(target ? target.title : text);
		if (marks.code)
			html = `<code class="bg-surface px-1 py-0.5 rounded font-mono text-[0.9em] border border-border">${html}</code>`;
		if (marks.bold) html = `<strong class="font-semibold">${html}</strong>`;
		if (marks.italic) html = `<em>${html}</em>`;
		if (marks.strikethrough) html = `<s class="line-through text-muted">${html}</s>`;
		if (marks.link?.startsWith(RECORD_LINK_SCHEME)) {
			if (target) {
				const href = target.kind === 'collection' ? `/table/${target.id}` : `/doc/${target.id}`;
				html = `<a href="${escapeHtml(href)}" class="text-accent underline underline-offset-2">${html}</a>`;
			} else {
				html = `<span class="text-muted italic line-through decoration-dotted" title="Linked page was deleted">${html}</span>`;
			}
		} else if (marks.link) {
			html = `<a href="${escapeHtml(safeHref(marks.link))}" class="text-accent underline underline-offset-2" rel="noopener noreferrer nofollow">${html}</a>`;
		}
		return html;
	}

	export function render(): void {
		if (!el) return;
		// A remote peer can edit this same block while the user is mid-IME-
		// composition. Rewriting el.innerHTML in that window would blow away
		// the browser's own composition UI, so defer to compositionend, which
		// re-derives the DOM from the now-current ytext (local edit included).
		if (isComposing) return;
		const richText = yTextToRichText(ytext);
		const html = richText.runs.map((r) => runToHtml(r.text, r.marks)).join('');
		const caret = document.activeElement === el ? getCaretOffset(el) : null;
		// Bespoke rich-text rendering: this contenteditable's content is derived
		// entirely from the Y.Text CRDT, not from Svelte-owned markup, so direct
		// DOM writes here are the intended mechanism, not an accidental desync.
		// eslint-disable-next-line svelte/no-dom-manipulating
		el.innerHTML = html;
		lastPlainText = plainText(richText);
		if (caret !== null) setCaretOffset(el, Math.min(caret, lastPlainText.length));
	}

	function handleCompositionStart(): void {
		isComposing = true;
	}

	function handleCompositionEnd(): void {
		isComposing = false;
		handleInput();
		// Whether or not handleInput() itself mutated ytext (and so already
		// re-triggered render() via the observer below), re-render once more
		// so any remote edit that arrived — and was skipped — during
		// composition is guaranteed to be reflected.
		render();
	}

	function handleInput(): void {
		if (!el) return;
		// While an IME composition is in progress, `innerText` only reflects an
		// uncommitted intermediate string. Syncing that to Y.Text now — and, via
		// the ytext.observe(render) below, immediately rewriting el.innerHTML out
		// from under the browser's own composition UI — corrupts CJK/other IME
		// input. Defer until compositionend commits the final text instead.
		if (isComposing) return;
		const newText = el.innerText.replace(/\n$/, '');
		const diff = diffPlainText(lastPlainText, newText);
		if (diff.deleteCount === 0 && diff.insertText === '') return;

		const doc = ytext.doc;
		const apply = () => {
			if (diff.deleteCount > 0) ytext.delete(diff.start, diff.deleteCount);
			if (diff.insertText) ytext.insert(diff.start, diff.insertText);
		};
		if (doc) doc.transact(apply);
		else apply();
		lastPlainText = newText;
		onInputText();

		if (newText === '/') onSlashKey();
	}

	const SHORTCUT_MARKS: Record<string, keyof TextMarks> = {
		b: 'bold',
		i: 'italic',
		x: 'strikethrough',
		e: 'code'
	};

	function handleKeydown(event: KeyboardEvent): void {
		// keyCode 229 is the legacy signal some browsers still send instead of
		// isComposing for IME-driven key events (e.g. committing a composition
		// with Enter). Either way, structural shortcuts like the Enter-splits-
		// block behavior below must not fire mid-composition.
		if (event.isComposing || event.keyCode === 229) return;
		if (event.key === 'Enter') {
			event.preventDefault();
			onEnter(el ? getCaretOffset(el) : lastPlainText.length);
			return;
		}
		if (event.key === 'Backspace' && el) {
			// Word-processor convention: Backspace at the very start of a
			// block's text joins it onto the end of the previous block, same
			// as it would join two lines of a single document — not just
			// when this block happens to be empty. An empty block always
			// counts as "at the start" (there's only one possible caret
			// position in it); a non-empty one needs an actual collapsed
			// caret at offset 0. +page.svelte's handleBackspace decides how
			// to join based on both blocks' content.
			const offsets = getSelectionOffsets(el);
			const atStart =
				lastPlainText === '' || (offsets !== null && offsets.start === 0 && offsets.end === 0);
			if (atStart) {
				event.preventDefault();
				onBackspaceAtStart();
				return;
			}
		}
		if ((event.metaKey || event.ctrlKey) && SHORTCUT_MARKS[event.key.toLowerCase()]) {
			event.preventDefault();
			applyFormat(SHORTCUT_MARKS[event.key.toLowerCase()]);
			return;
		}
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
			event.preventDefault();
			onLinkShortcut();
		}
	}

	export function getSelectionRange(): { start: number; end: number } | null {
		return el ? getSelectionOffsets(el) : null;
	}

	export function getFormatState(): Partial<Record<keyof TextMarks, boolean>> {
		if (!el) return {};
		const offsets = getSelectionOffsets(el);
		if (!offsets || ytext.length === 0) return {};

		// A collapsed selection inherits the character immediately after the
		// caret, or the preceding character at the end of a block. A ranged
		// selection is active only when every selected run carries that mark.
		const start =
			offsets.start === offsets.end && offsets.start === ytext.length
				? Math.max(0, offsets.start - 1)
				: offsets.start;
		const end = offsets.start === offsets.end ? start + 1 : offsets.end;
		const runs = yTextToRichText(ytext).runs;
		const marks: (keyof TextMarks)[] = ['bold', 'italic', 'strikethrough', 'code', 'link'];
		const state: Partial<Record<keyof TextMarks, boolean>> = {};
		let offset: number;

		for (const mark of marks) {
			let hasSelection = false;
			let markedThroughout = true;
			offset = 0;
			for (const run of runs) {
				const runEnd = offset + run.text.length;
				if (start < runEnd && end > offset) {
					hasSelection = true;
					if (!run.marks[mark]) markedThroughout = false;
				}
				offset = runEnd;
			}
			if (hasSelection && markedThroughout) state[mark] = true;
		}

		return state;
	}

	export function applyFormat(mark: keyof TextMarks, value?: unknown): void {
		if (!el) return;
		const offsets = getSelectionOffsets(el);
		if (!offsets) return;
		applyFormatAtRange(mark, offsets, value);
	}

	export function applyFormatAtRange(
		mark: keyof TextMarks,
		offsets: { start: number; end: number },
		value?: unknown
	): void {
		if (offsets.start === offsets.end) return;
		const nextValue = value === undefined ? (getFormatState()[mark] ? null : true) : value;
		const doc = ytext.doc;
		const apply = () =>
			ytext.format(offsets.start, offsets.end - offsets.start, { [mark]: nextValue });
		if (doc) doc.transact(apply);
		else apply();
	}

	// `position` is either the boolean shorthand (start/end) most callers
	// want, or an exact character offset — used to land the caret at the
	// join point when Backspace merges a block's text onto the end of this
	// one, rather than always at its very end.
	export function focusEditor(position: boolean | number = false): void {
		el?.focus();
		if (!el) return;
		const offset = typeof position === 'number' ? position : position ? 0 : lastPlainText.length;
		setCaretOffset(el, offset);
	}

	$effect(() => {
		ytext.observe(render);
		render();
		// An inline record: link (§ runToHtml) resolves its target's title/kind
		// from linkTargets — catalog-backed (data.documents/data.collections),
		// not this block's own ytext.doc. Before #120, that doc was the single
		// shared workspace doc every Document/Collection lived in, so observing
		// its documents/collections maps caught a rename or delete anywhere and
		// re-rendered this already-mounted block instantly. Post-#120 that's no
		// longer possible: this doc is now just this block's own Document's
		// isolated shard, which never sees another Document's mutations. A
		// rename/delete elsewhere is accurate as of the next page load instead
		// — the same accepted tradeoff as Sidebar's document tree (#120, #121
		// tracks a real live catalog feed).
		return () => {
			ytext.unobserve(render);
		};
	});
</script>

<div
	bind:this={el}
	class="block-editor min-h-[1.5em] py-0.5 leading-relaxed break-words text-fg outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent {className}"
	data-block-editor-id={recordId}
	contenteditable="true"
	role="textbox"
	tabindex="0"
	aria-multiline="false"
	aria-label={placeholder || 'Block content'}
	aria-placeholder={placeholder || undefined}
	data-placeholder={placeholder}
	oninput={handleInput}
	onkeydown={handleKeydown}
	oncompositionstart={handleCompositionStart}
	oncompositionend={handleCompositionEnd}
	onfocus={onFocusBlock}
></div>

<style>
	.block-editor:empty::before {
		content: attr(data-placeholder);
		color: var(--color-muted);
		opacity: 0.7;
		pointer-events: none;
	}
</style>
