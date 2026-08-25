import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import * as Y from 'yjs';
import { createDocument, deleteDocument } from '$lib/data/records';
import BlockEditor from './BlockEditor.svelte';

function selectRange(el: HTMLElement, start: number, end: number): void {
	const textNode = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode() as Text;
	const range = document.createRange();
	range.setStart(textNode, start);
	range.setEnd(textNode, end);
	const selection = window.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
}

function handlers() {
	return {
		onInputText: vi.fn(),
		onEnter: vi.fn(),
		onBackspaceAtStart: vi.fn(),
		onFocusBlock: vi.fn(),
		onSlashKey: vi.fn()
	};
}

describe('BlockEditor', () => {
	let doc: Y.Doc;

	beforeEach(() => {
		doc = new Y.Doc();
	});

	afterEach(() => {
		doc.destroy();
	});

	it('renders the ytext content into the contenteditable element', () => {
		const ytext = doc.getText('a');
		ytext.insert(0, 'hello world');
		const { container } = render(BlockEditor, { ytext, ...handlers() });
		const el = container.querySelector('[contenteditable]')!;
		expect(el.textContent).toBe('hello world');
	});

	it('renders marks as nested formatting elements', () => {
		const ytext = doc.getText('a');
		ytext.insert(0, 'bold', { bold: true });
		const { container } = render(BlockEditor, { ytext, ...handlers() });
		const el = container.querySelector('[contenteditable]')!;
		expect(el.querySelector('strong')).toHaveTextContent('bold');
	});

	it('renders a link mark as an anchor with a safe href', () => {
		const ytext = doc.getText('a');
		ytext.insert(0, 'click me', { link: 'https://example.com/x' });
		const { container } = render(BlockEditor, { ytext, ...handlers() });
		const anchor = container.querySelector('a')!;
		expect(anchor).toHaveAttribute('href', 'https://example.com/x');
		expect(anchor).toHaveAttribute('rel', 'noopener noreferrer nofollow');
	});

	it('neutralizes an unsafe link protocol to a dead link', () => {
		const ytext = doc.getText('a');
		ytext.insert(0, 'danger', { link: 'javascript:alert(1)' });
		const { container } = render(BlockEditor, { ytext, ...handlers() });
		expect(container.querySelector('a')).toHaveAttribute('href', '#');
	});

	it('renders an inline wiki-link mark as a navigable link to its current target', () => {
		const target = createDocument(doc, { title: 'Q3 Roadmap' });
		const ytext = doc.getText('a');
		ytext.insert(0, 'Q3 Roadmap', { link: `record:${target.id}` });
		const { container } = render(BlockEditor, { ytext, ...handlers() });
		const anchor = container.querySelector('a')!;
		expect(anchor).toHaveAttribute('href', `/doc/${target.id}`);
		expect(anchor).toHaveTextContent('Q3 Roadmap');
	});

	it('renders an inline wiki-link mark as a distinct broken state once its target is deleted', () => {
		const target = createDocument(doc, { title: 'Q3 Roadmap' });
		const ytext = doc.getText('a');
		ytext.insert(0, 'Q3 Roadmap', { link: `record:${target.id}` });
		deleteDocument(doc, target.id);

		const { container } = render(BlockEditor, { ytext, ...handlers() });
		expect(container.querySelector('a')).toBeNull();
		const span = container.querySelector('[title="Linked page was deleted"]')!;
		expect(span).toHaveTextContent('Q3 Roadmap');
	});

	it('escapes HTML special characters in the plain text', () => {
		const ytext = doc.getText('a');
		ytext.insert(0, '<b>&"\'');
		const { container } = render(BlockEditor, { ytext, ...handlers() });
		const el = container.querySelector('[contenteditable]')!;
		expect(el.textContent).toBe('<b>&"\'');
		expect(el.querySelector('b')).toBeNull();
	});

	it('shows the placeholder as an aria-placeholder and data attribute', () => {
		const ytext = doc.getText('a');
		const { container } = render(BlockEditor, {
			ytext,
			placeholder: 'Type something…',
			...handlers()
		});
		const el = container.querySelector('[contenteditable]')!;
		expect(el).toHaveAttribute('aria-placeholder', 'Type something…');
		expect(el).toHaveAttribute('data-placeholder', 'Type something…');
	});

	it('writes typed text into the shared ytext', async () => {
		const ytext = doc.getText('a');
		const { container } = render(BlockEditor, { ytext, ...handlers() });
		const el = container.querySelector('[contenteditable]') as HTMLElement;

		el.textContent = 'hi';
		await fireEvent.input(el);

		expect(ytext.toString()).toBe('hi');
	});

	it('calls onInputText after a keystroke updates ytext', async () => {
		const ytext = doc.getText('a');
		const hs = handlers();
		const { container } = render(BlockEditor, { ytext, ...hs });
		const el = container.querySelector('[contenteditable]') as HTMLElement;

		el.textContent = 'x';
		await fireEvent.input(el);

		expect(hs.onInputText).toHaveBeenCalledOnce();
	});

	it('calls onSlashKey when the block becomes exactly "/"', async () => {
		const ytext = doc.getText('a');
		const hs = handlers();
		const { container } = render(BlockEditor, { ytext, ...hs });
		const el = container.querySelector('[contenteditable]') as HTMLElement;

		el.textContent = '/';
		await fireEvent.input(el);

		expect(hs.onSlashKey).toHaveBeenCalledOnce();
	});

	it('does not call onSlashKey for text that merely contains a slash', async () => {
		const ytext = doc.getText('a');
		const hs = handlers();
		const { container } = render(BlockEditor, { ytext, ...hs });
		const el = container.querySelector('[contenteditable]') as HTMLElement;

		el.textContent = 'a/b';
		await fireEvent.input(el);

		expect(hs.onSlashKey).not.toHaveBeenCalled();
	});

	it('prevents default and calls onEnter on Enter', async () => {
		const ytext = doc.getText('a');
		const hs = handlers();
		const { container } = render(BlockEditor, { ytext, ...hs });
		const el = container.querySelector('[contenteditable]') as HTMLElement;

		const event = await fireEvent.keyDown(el, { key: 'Enter' });
		expect(hs.onEnter).toHaveBeenCalledOnce();
		expect(event).toBe(false); // fireEvent returns false when preventDefault() was called
	});

	it('calls onBackspaceAtStart on Backspace in an empty block', async () => {
		const ytext = doc.getText('a');
		const hs = handlers();
		const { container } = render(BlockEditor, { ytext, ...hs });
		const el = container.querySelector('[contenteditable]') as HTMLElement;

		await fireEvent.keyDown(el, { key: 'Backspace' });
		expect(hs.onBackspaceAtStart).toHaveBeenCalledOnce();
	});

	it('does not call onBackspaceAtStart when the block already has text', async () => {
		const ytext = doc.getText('a');
		ytext.insert(0, 'not empty');
		const hs = handlers();
		const { container } = render(BlockEditor, { ytext, ...hs });
		const el = container.querySelector('[contenteditable]') as HTMLElement;

		await fireEvent.keyDown(el, { key: 'Backspace' });
		expect(hs.onBackspaceAtStart).not.toHaveBeenCalled();
	});

	it('calls onFocusBlock when the element is focused', async () => {
		const ytext = doc.getText('a');
		const hs = handlers();
		const { container } = render(BlockEditor, { ytext, ...hs });
		const el = container.querySelector('[contenteditable]') as HTMLElement;

		await fireEvent.focus(el);
		expect(hs.onFocusBlock).toHaveBeenCalledOnce();
	});

	it('applies bold formatting to the selected range on Cmd/Ctrl+B', async () => {
		const ytext = doc.getText('a');
		ytext.insert(0, 'hello world');
		const { container } = render(BlockEditor, { ytext, ...handlers() });
		const el = container.querySelector('[contenteditable]') as HTMLElement;

		selectRange(el, 0, 5);
		await fireEvent.keyDown(el, { key: 'b', ctrlKey: true });

		const delta = ytext.toDelta() as { insert: string; attributes?: { bold?: boolean } }[];
		expect(delta[0]).toMatchObject({ insert: 'hello', attributes: { bold: true } });
	});

	it('ignores Cmd/Ctrl+B with no active selection', async () => {
		const ytext = doc.getText('a');
		ytext.insert(0, 'hello world');
		const { container } = render(BlockEditor, { ytext, ...handlers() });
		const el = container.querySelector('[contenteditable]') as HTMLElement;

		await fireEvent.keyDown(el, { key: 'b', ctrlKey: true });

		const delta = ytext.toDelta() as { insert: string; attributes?: unknown }[];
		expect(delta[0].attributes).toBeUndefined();
	});

	it('reports marks that apply throughout the current selection', () => {
		const ytext = doc.getText('a');
		ytext.insert(0, 'bold', { bold: true });
		const { container, component } = render(BlockEditor, { ytext, ...handlers() });
		const el = container.querySelector('[contenteditable]') as HTMLElement;

		selectRange(el, 0, 4);

		expect(component.getFormatState()).toMatchObject({ bold: true });
		expect(component.getFormatState().italic).toBeUndefined();
	});

	it('toggles an existing mark off when formatting from an active selection', () => {
		const ytext = doc.getText('a');
		ytext.insert(0, 'bold', { bold: true });
		const { container, component } = render(BlockEditor, { ytext, ...handlers() });
		const el = container.querySelector('[contenteditable]') as HTMLElement;

		selectRange(el, 0, 4);
		component.applyFormat('bold');

		const delta = ytext.toDelta() as { insert: string; attributes?: { bold?: boolean } }[];
		expect(delta[0]).toMatchObject({ insert: 'bold' });
		expect(delta[0].attributes?.bold).toBeUndefined();
	});

	it('prompts for a URL and applies a link mark on Cmd/Ctrl+K', async () => {
		const ytext = doc.getText('a');
		ytext.insert(0, 'hello world');
		const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('https://example.com');
		const { container } = render(BlockEditor, { ytext, ...handlers() });
		const el = container.querySelector('[contenteditable]') as HTMLElement;

		selectRange(el, 0, 5);
		await fireEvent.keyDown(el, { key: 'k', metaKey: true });

		const delta = ytext.toDelta() as { insert: string; attributes?: { link?: string } }[];
		expect(delta[0]).toMatchObject({
			insert: 'hello',
			attributes: { link: 'https://example.com' }
		});
		promptSpy.mockRestore();
	});

	it('does not apply a link mark when the URL prompt is cancelled', async () => {
		const ytext = doc.getText('a');
		ytext.insert(0, 'hello world');
		const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue(null);
		const { container } = render(BlockEditor, { ytext, ...handlers() });
		const el = container.querySelector('[contenteditable]') as HTMLElement;

		selectRange(el, 0, 5);
		await fireEvent.keyDown(el, { key: 'k', metaKey: true });

		const delta = ytext.toDelta() as { insert: string; attributes?: unknown }[];
		expect(delta[0].attributes).toBeUndefined();
		promptSpy.mockRestore();
	});

	it('does not split the block on Enter mid IME composition', async () => {
		const ytext = doc.getText('a');
		const hs = handlers();
		const { container } = render(BlockEditor, { ytext, ...hs });
		const el = container.querySelector('[contenteditable]') as HTMLElement;

		await fireEvent.keyDown(el, { key: 'Enter', isComposing: true });
		expect(hs.onEnter).not.toHaveBeenCalled();
	});

	it('re-renders from ytext once composition ends', async () => {
		const ytext = doc.getText('a');
		const { container } = render(BlockEditor, { ytext, ...handlers() });
		const el = container.querySelector('[contenteditable]') as HTMLElement;

		await fireEvent.compositionStart(el);
		el.textContent = '日本語';
		await fireEvent.compositionEnd(el);

		expect(ytext.toString()).toBe('日本語');
		expect(el.textContent).toBe('日本語');
	});

	it('exposes render/applyFormat/focusEditor on the component instance for parent bind:this usage', () => {
		const ytext = doc.getText('a');
		ytext.insert(0, 'hello');
		const { component } = render(BlockEditor, { ytext, ...handlers() });
		expect(component.render).toBeTypeOf('function');
		expect(component.applyFormat).toBeTypeOf('function');
		expect(component.focusEditor).toBeTypeOf('function');
	});

	it('focusEditor() focuses the element', () => {
		const ytext = doc.getText('a');
		ytext.insert(0, 'hello');
		const { container, component } = render(BlockEditor, { ytext, ...handlers() });
		const el = container.querySelector('[contenteditable]') as HTMLElement;

		component.focusEditor();

		expect(document.activeElement).toBe(el);
	});
});
