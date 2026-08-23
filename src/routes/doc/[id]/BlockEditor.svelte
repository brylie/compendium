<script lang="ts">
	import type * as Y from 'yjs';
	import { diffPlainText } from '$lib/client/text-diff';
	import { getCaretOffset, getSelectionOffsets, setCaretOffset } from '$lib/client/caret';
	import { plainText, yTextToRichText } from '$lib/data/richtext';
	import type { TextMarks } from '$lib/data/types';

	let {
		ytext,
		placeholder = '',
		class: className = '',
		onInputText,
		onEnter,
		onBackspaceAtStart,
		onFocusBlock,
		onSlashKey
	}: {
		ytext: Y.Text;
		placeholder?: string;
		class?: string;
		onInputText: () => void;
		onEnter: () => void;
		onBackspaceAtStart: () => void;
		onFocusBlock: () => void;
		onSlashKey: () => void;
	} = $props();

	let el: HTMLDivElement | undefined = $state();
	let lastPlainText = '';

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

	function runToHtml(text: string, marks: TextMarks): string {
		let html = escapeHtml(text);
		if (marks.code)
			html = `<code class="bg-surface px-1 py-0.5 rounded font-mono text-[0.9em] border border-border">${html}</code>`;
		if (marks.bold) html = `<strong class="font-semibold">${html}</strong>`;
		if (marks.italic) html = `<em>${html}</em>`;
		if (marks.strikethrough) html = `<s class="line-through text-muted">${html}</s>`;
		if (marks.link)
			html = `<a href="${escapeHtml(safeHref(marks.link))}" class="text-accent underline underline-offset-2" rel="noopener noreferrer nofollow">${html}</a>`;
		return html;
	}

	export function render(): void {
		if (!el) return;
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

	function handleInput(): void {
		if (!el) return;
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
		if (event.key === 'Enter') {
			event.preventDefault();
			onEnter();
			return;
		}
		if (event.key === 'Backspace' && el && lastPlainText === '' && getCaretOffset(el) === 0) {
			event.preventDefault();
			onBackspaceAtStart();
			return;
		}
		if ((event.metaKey || event.ctrlKey) && SHORTCUT_MARKS[event.key.toLowerCase()]) {
			event.preventDefault();
			applyFormat(SHORTCUT_MARKS[event.key.toLowerCase()]);
			return;
		}
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
			event.preventDefault();
			const url = window.prompt('Link URL:');
			if (url) applyFormat('link', url);
		}
	}

	export function applyFormat(mark: keyof TextMarks, value: unknown = true): void {
		if (!el) return;
		const offsets = getSelectionOffsets(el);
		if (!offsets || offsets.start === offsets.end) return;
		const doc = ytext.doc;
		const apply = () => ytext.format(offsets.start, offsets.end - offsets.start, { [mark]: value });
		if (doc) doc.transact(apply);
		else apply();
	}

	export function focusEditor(atStart = false): void {
		el?.focus();
		if (el) setCaretOffset(el, atStart ? 0 : lastPlainText.length);
	}

	$effect(() => {
		ytext.observe(render);
		render();
		return () => ytext.unobserve(render);
	});
</script>

<div
	bind:this={el}
	class="block-editor min-h-[1.5em] py-0.5 leading-relaxed break-words text-fg outline-none {className}"
	contenteditable="true"
	role="textbox"
	tabindex="0"
	aria-multiline="false"
	data-placeholder={placeholder}
	oninput={handleInput}
	onkeydown={handleKeydown}
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
