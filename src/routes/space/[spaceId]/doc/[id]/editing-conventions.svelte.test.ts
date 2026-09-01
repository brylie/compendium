// Acceptance tests for the block editor's word-processor conventions:
// Enter, Backspace, and the persistent toolbar's insert/convert/format
// controls. The block model underneath is an implementation detail — these
// tests exist to pin down, explicitly and by example, how the editor is
// expected to *feel* for the everyday interactions a person already has
// muscle memory for from Word, Google Docs, and Notion, so a change that
// breaks that feel fails a test instead of shipping as a quiet regression.
// See docs/specifications/rich-text-toolbar.md §5–5.3 for the written
// contract these tests verify, and docs/prd.md's "Block
// editor interaction" section for the product-level requirement.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { createDocument, createRecord, getDocument, getRecordYText } from '$lib/data/records';
import { plainText, yTextToRichText } from '$lib/data/richtext';
import type { ActorId } from '$lib/data/types';
import Page from './+page.svelte';

vi.mock('$app/state', () => ({
	get page() {
		return { params: { spaceId: 'space-1' } };
	}
}));

const HUMAN: ActorId = { kind: 'human', userId: 'local' };

function selectRange(el: HTMLElement, start: number, end: number): void {
	// Walks actual text nodes rather than assuming el.firstChild is one
	// directly: a marked run (e.g. bold) renders wrapped in <strong>, so a
	// flat "first child is the text node" assumption breaks as soon as any
	// test exercises formatted text.
	function textNodeAtOffset(root: Node, offset: number): { node: Text; offset: number } {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let remaining = offset;
		let node: Node | null;
		let last: Text | null = null;
		while ((node = walker.nextNode())) {
			const text = node as Text;
			if (remaining <= text.data.length) return { node: text, offset: remaining };
			remaining -= text.data.length;
			last = text;
		}
		if (!last) throw new Error('selectRange: no text node found in element');
		return { node: last, offset: last.data.length };
	}

	const startPos = textNodeAtOffset(el, start);
	const endPos = textNodeAtOffset(el, end);
	const range = document.createRange();
	range.setStart(startPos.node, startPos.offset);
	range.setEnd(endPos.node, endPos.offset);
	const selection = window.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
	document.dispatchEvent(new Event('selectionchange'));
}

// Stands in for the selection moving to non-editor page UI (the title
// input, the sidebar, anywhere without a [data-block-editor-id] ancestor):
// syncToolbarSelection reads document.getSelection(), not which element was
// clicked, so an empty selection exercises the same "outside any block
// editor" branch regardless of what the user actually clicked.
function clearSelection(): void {
	window.getSelection()!.removeAllRanges();
	document.dispatchEvent(new Event('selectionchange'));
}

let ydoc: Y.Doc;
vi.mock('$lib/client/yjs-client', () => ({
	getClientDoc: () => ydoc,
	getShardDoc: () => ydoc,
	getShardAwareness: () => ({})
}));

function textOf(recordId: string): string {
	const ytext = getRecordYText(ydoc, recordId);
	return ytext ? plainText(yTextToRichText(ytext)) : '';
}

const claimBlockPresence = vi.hoisted(() => vi.fn());
const releaseBlockPresence = vi.hoisted(() => vi.fn());
const subscribeHeldByOthers = vi.hoisted(() =>
	vi.fn((onChange: (held: Map<string, ActorId>) => void) => {
		onChange(new Map());
		return () => {};
	})
);
vi.mock('$lib/client/presence', () => ({
	claimBlockPresence,
	releaseBlockPresence,
	subscribeHeldByOthers
}));

// The document itself is created once in beforeEach, before each test body
// runs — tests create their records against it first, then call this to
// render, matching how every test in this file is structured. Async because
// +page.svelte resolves its real shard via a fetch before connecting (#120)
// — see table/[id]'s page.svelte.test.ts for the identical technique.
async function renderDoc() {
	const result = render(Page, {
		params: { spaceId: 'space-1', id: 'doc-1' },
		form: null,
		data: {
			spaces: [],
			spaceId: 'space-1',
			activeSpaceId: 'space-1',
			documents: [],
			collections: [],
			documentId: 'doc-1',
			title: 'D'
		}
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	return result;
}

describe('editing conventions: Enter, Backspace, and toolbar block controls', () => {
	beforeEach(() => {
		ydoc = new Y.Doc();
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		claimBlockPresence.mockClear();
		releaseBlockPresence.mockClear();
		subscribeHeldByOthers.mockClear().mockImplementation(() => () => {});
		// +page.svelte resolves its real shard via a fetch before connecting —
		// see #120. Stubbed to resolve immediately against the same test doc.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ json: async () => ({ shardId: 'test-shard' }) }))
		);
	});

	afterEach(() => {
		ydoc.destroy();
		vi.unstubAllGlobals();
	});

	describe('Toolbar: insert a new block vs. convert the active one in place', () => {
		it('inserts a new block when nothing is active', async () => {
			await renderDoc();
			const user = userEvent.setup();

			await user.click(screen.getByRole('button', { name: 'Insert Table' }));

			const doc = getDocument(ydoc, 'doc-1')!;
			expect(doc.recordIds).toHaveLength(1);
			expect(
				(ydoc.getMap('records').get(doc.recordIds[0]) as Y.Map<unknown>).get('blockType')
			).toBe('table');
		});

		it('inserts a new block, rather than converting nothing, for a text-bearing control when nothing is active', async () => {
			await renderDoc();
			const user = userEvent.setup();

			await user.click(screen.getByRole('button', { name: 'Insert Bulleted list' }));

			const recordIds = getDocument(ydoc, 'doc-1')!.recordIds;
			expect(recordIds).toHaveLength(1);
			const yrecord = ydoc.getMap('records').get(recordIds[0]) as Y.Map<unknown>;
			expect(yrecord.get('blockType')).toBe('bulleted_list_item');
		});

		it('converts the active block in place, preserving its text, instead of inserting a new one', async () => {
			const record = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
			getRecordYText(ydoc, record.id)!.insert(0, 'Buy milk');
			const user = userEvent.setup();
			const { container } = await renderDoc();

			const editor = container.querySelector('[contenteditable]') as HTMLElement;
			await user.click(editor);
			await user.click(screen.getByRole('button', { name: 'Insert Bulleted list' }));

			const recordIds = getDocument(ydoc, 'doc-1')!.recordIds;
			expect(recordIds).toEqual([record.id]);
			const yrecord = ydoc.getMap('records').get(record.id) as Y.Map<unknown>;
			expect(yrecord.get('blockType')).toBe('bulleted_list_item');
			expect(textOf(record.id)).toBe('Buy milk');
		});

		it('toggles a block back to a paragraph when its own toolbar control is clicked again', async () => {
			const record = createRecord(
				ydoc,
				{ parentId: 'doc-1', blockType: 'bulleted_list_item' },
				HUMAN
			);
			getRecordYText(ydoc, record.id)!.insert(0, 'Buy milk');
			const user = userEvent.setup();
			const { container } = await renderDoc();

			const editor = container.querySelector('[contenteditable]') as HTMLElement;
			await user.click(editor);
			await user.click(screen.getByRole('button', { name: 'Insert Bulleted list' }));

			const recordIds = getDocument(ydoc, 'doc-1')!.recordIds;
			expect(recordIds).toEqual([record.id]);
			const yrecord = ydoc.getMap('records').get(record.id) as Y.Map<unknown>;
			expect(yrecord.get('blockType')).toBe('paragraph');
			expect(textOf(record.id)).toBe('Buy milk');
		});

		it('inserts after a synced block rather than converting it in place, leaving its referenced content untouched', async () => {
			// Regression test: the in-place-conversion gate previously checked
			// only the *target* control's type, not the active block's own type.
			// A synced block renders a BlockEditor bound to its referenced
			// record's Y.Text, so converting the synced block itself in place
			// changed its blockType away from 'synced_block' — at which point
			// the block stops resolving to the referenced text at all and
			// starts reading its own (empty) Y.Text instead, so the previously
			// displayed content silently disappears.
			const referenced = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
			getRecordYText(ydoc, referenced.id)!.insert(0, 'Shared content');
			const synced = createRecord(
				ydoc,
				{ parentId: 'doc-1', blockType: 'synced_block', referencedRecordId: referenced.id },
				HUMAN
			);
			const user = userEvent.setup();
			const { container } = await renderDoc();

			// Two blocks render: the referenced paragraph first, then the synced
			// block — target the synced block's editor specifically, not
			// whichever happens to be first in the DOM.
			const editors = container.querySelectorAll('[contenteditable]');
			await user.click(editors[1] as HTMLElement);
			await user.click(screen.getByRole('button', { name: 'Insert Bulleted list' }));

			const recordIds = getDocument(ydoc, 'doc-1')!.recordIds;
			expect(recordIds).toHaveLength(3); // referenced + synced + newly inserted
			const syncedRecord = ydoc.getMap('records').get(synced.id) as Y.Map<unknown>;
			expect(syncedRecord.get('blockType')).toBe('synced_block');
			expect(textOf(referenced.id)).toBe('Shared content');
		});

		it('keeps the active block through a toolbar insert click, inserting after it rather than at the end', async () => {
			const first = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
			const middle = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
			createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
			getRecordYText(ydoc, first.id)!.insert(0, 'First');
			getRecordYText(ydoc, middle.id)!.insert(0, 'Middle');
			const user = userEvent.setup();
			const { container } = await renderDoc();

			const editors = container.querySelectorAll('[contenteditable]');
			await user.click(editors[1] as HTMLElement); // the "Middle" block, not the last one

			await user.click(screen.getByRole('button', { name: 'Insert Divider' }));

			const recordIds = getDocument(ydoc, 'doc-1')!.recordIds;
			const middleIndex = recordIds.indexOf(middle.id);
			const newRecordId = recordIds.find(
				(id) => (ydoc.getMap('records').get(id) as Y.Map<unknown>).get('blockType') === 'divider'
			)!;
			expect(recordIds.indexOf(newRecordId)).toBe(middleIndex + 1);
		});
	});

	describe('Toolbar: formatting controls track the active selection', () => {
		it('formats the active text selection directly from the persistent toolbar', async () => {
			const record = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
			getRecordYText(ydoc, record.id)!.insert(0, 'Hello');
			const user = userEvent.setup();
			const { container } = await renderDoc();

			const editor = container.querySelector('[contenteditable]') as HTMLElement;
			await user.click(editor);
			selectRange(editor, 0, 5);
			await user.click(screen.getByRole('button', { name: 'Bold' }));

			const delta = getRecordYText(ydoc, record.id)!.toDelta() as {
				insert: string;
				attributes?: { bold?: boolean };
			}[];
			expect(delta[0]).toMatchObject({ insert: 'Hello', attributes: { bold: true } });
			expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
		});

		it('disables formatting controls once the selection moves outside any block editor', async () => {
			createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
			const user = userEvent.setup();
			const { container } = await renderDoc();

			const editor = container.querySelector('[contenteditable]') as HTMLElement;
			await user.click(editor);
			expect(screen.getByRole('button', { name: 'Bold' })).not.toBeDisabled();

			// Focus a real non-editor control (the title input stands in for
			// "the title, the sidebar, anywhere without a block editor
			// ancestor"). jsdom doesn't replicate a real browser's side effect
			// of clearing document.getSelection() when focus leaves a
			// contenteditable, so clearSelection() still does that part — but
			// the focus transition itself must actually happen here too, or
			// this only tests syncToolbarSelection's branch logic in isolation
			// rather than the real interaction it exists to guard: the
			// previously focused block must stop being treated as active, or a
			// stray click on a format control would silently reformat text the
			// user can no longer see is "selected".
			const titleInput = screen.getByPlaceholderText('Untitled document');
			await user.click(titleInput);
			clearSelection();
			await tick();

			expect(titleInput).toHaveFocus();
			expect(screen.getByRole('button', { name: 'Bold' })).toBeDisabled();
		});
	});

	describe('Enter: splitting text, continuing a list, and exiting an empty list item', () => {
		it('splits a plain paragraph at the caret, not just a list item', async () => {
			const record = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
			getRecordYText(ydoc, record.id)!.insert(0, 'Hello world');
			const { container } = await renderDoc();

			const editor = container.querySelector('[contenteditable]') as HTMLElement;
			selectRange(editor, 5, 5); // caret right after "Hello"
			editor.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
			);
			await tick();

			const recordIds = getDocument(ydoc, 'doc-1')!.recordIds;
			expect(recordIds).toHaveLength(2);
			expect(textOf(record.id)).toBe('Hello');
			expect(textOf(recordIds[1])).toBe(' world');
		});

		it.each(['quote', 'callout', 'code'] as const)(
			'splits a %s block at the caret, not just paragraphs/headings/lists',
			async (blockType) => {
				// Regression test: quote, callout, and code blocks used to wire
				// Enter straight to addBlockAfter instead of routing through
				// handleEnter/splitBlockOnEnter, so Enter mid-text appended an
				// empty block instead of splitting at the caret.
				const record = createRecord(ydoc, { parentId: 'doc-1', blockType }, HUMAN);
				getRecordYText(ydoc, record.id)!.insert(0, 'Hello world');
				const { container } = await renderDoc();

				const editor = container.querySelector('[contenteditable]') as HTMLElement;
				selectRange(editor, 5, 5); // caret right after "Hello"
				editor.dispatchEvent(
					new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
				);
				await tick();

				const recordIds = getDocument(ydoc, 'doc-1')!.recordIds;
				expect(recordIds).toHaveLength(2);
				expect(textOf(record.id)).toBe('Hello');
				expect(textOf(recordIds[1])).toBe(' world');
				const newRecord = ydoc.getMap('records').get(recordIds[1]) as Y.Map<unknown>;
				expect(newRecord.get('blockType')).toBe('paragraph');
			}
		);

		it('preserves marks on both halves of the text when splitting', async () => {
			const record = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
			const ytext = getRecordYText(ydoc, record.id)!;
			ytext.insert(0, 'Hello world', { bold: true });
			const { container } = await renderDoc();

			const editor = container.querySelector('[contenteditable]') as HTMLElement;
			selectRange(editor, 5, 5);
			editor.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
			);
			await tick();

			const recordIds = getDocument(ydoc, 'doc-1')!.recordIds;
			const beforeDelta = getRecordYText(ydoc, record.id)!.toDelta() as {
				insert: string;
				attributes?: { bold?: boolean };
			}[];
			const afterDelta = getRecordYText(ydoc, recordIds[1])!.toDelta() as {
				insert: string;
				attributes?: { bold?: boolean };
			}[];
			expect(beforeDelta[0]).toMatchObject({ insert: 'Hello', attributes: { bold: true } });
			expect(afterDelta[0]).toMatchObject({ insert: ' world', attributes: { bold: true } });
		});

		it.each([
			['bulleted_list_item', 'Milk'],
			['numbered_list_item', 'Eggs'],
			['to_do', 'Bread']
		] as const)(
			'continues a %s on Enter when the current item has text',
			async (blockType, text) => {
				const record = createRecord(ydoc, { parentId: 'doc-1', blockType }, HUMAN);
				getRecordYText(ydoc, record.id)!.insert(0, text);
				const { container } = await renderDoc();

				const editor = container.querySelector('[contenteditable]') as HTMLElement;
				selectRange(editor, text.length, text.length); // caret at the end, as after typing
				editor.dispatchEvent(
					new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
				);
				await tick();

				const recordIds = getDocument(ydoc, 'doc-1')!.recordIds;
				expect(recordIds).toHaveLength(2);
				expect(textOf(record.id)).toBe(text);
				const newRecord = ydoc.getMap('records').get(recordIds[1]) as Y.Map<unknown>;
				expect(newRecord.get('blockType')).toBe(blockType);
				expect(textOf(recordIds[1])).toBe('');
			}
		);

		it('splits a list item at the caret, moving the text after it into the new item', async () => {
			const record = createRecord(
				ydoc,
				{ parentId: 'doc-1', blockType: 'bulleted_list_item' },
				HUMAN
			);
			getRecordYText(ydoc, record.id)!.insert(0, 'Buy milk and eggs');
			const { container } = await renderDoc();

			const editor = container.querySelector('[contenteditable]') as HTMLElement;
			selectRange(editor, 8, 8); // caret right after "Buy milk"
			editor.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
			);
			await tick();

			const recordIds = getDocument(ydoc, 'doc-1')!.recordIds;
			expect(recordIds).toHaveLength(2);
			expect(textOf(record.id)).toBe('Buy milk');
			const newRecord = ydoc.getMap('records').get(recordIds[1]) as Y.Map<unknown>;
			expect(newRecord.get('blockType')).toBe('bulleted_list_item');
			expect(textOf(recordIds[1])).toBe(' and eggs');
		});

		it.each(['bulleted_list_item', 'numbered_list_item', 'to_do'] as const)(
			'exits a %s on Enter when the current item is empty, converting it to a paragraph in place',
			async (blockType) => {
				const record = createRecord(ydoc, { parentId: 'doc-1', blockType }, HUMAN);
				const { container } = await renderDoc();

				const editor = container.querySelector('[contenteditable]') as HTMLElement;
				editor.dispatchEvent(
					new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
				);
				await tick();

				const recordIds = getDocument(ydoc, 'doc-1')!.recordIds;
				expect(recordIds).toHaveLength(1);
				const yrecord = ydoc.getMap('records').get(record.id) as Y.Map<unknown>;
				expect(yrecord.get('blockType')).toBe('paragraph');
			}
		);

		it('exits the list on a second Enter at the start of a list item, instead of endlessly duplicating empty items', async () => {
			// Regression test: splitting at caret offset 0 previously left the
			// *new* block holding the text (and therefore focused), and the
			// *original* block empty but never refocused — so the real content
			// kept hopping into a fresh block on every subsequent Enter at
			// position 0, instead of the second press ever landing on an empty,
			// focused block that the ordinary empty-list-item-exit rule could
			// catch.
			const record = createRecord(
				ydoc,
				{ parentId: 'doc-1', blockType: 'bulleted_list_item' },
				HUMAN
			);
			getRecordYText(ydoc, record.id)!.insert(0, 'Milk');
			const { container } = await renderDoc();

			const editor = container.querySelector('[contenteditable]') as HTMLElement;
			selectRange(editor, 0, 0);
			editor.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
			);
			await tick();

			let recordIds = getDocument(ydoc, 'doc-1')!.recordIds;
			expect(recordIds).toHaveLength(2);
			expect(textOf(recordIds[0])).toBe('');
			expect(textOf(recordIds[1])).toBe('Milk');
			expect(document.activeElement).toHaveAttribute('data-block-editor-id', recordIds[0]);

			const focused = document.activeElement as HTMLElement;
			focused.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
			);
			await tick();

			recordIds = getDocument(ydoc, 'doc-1')!.recordIds;
			expect(recordIds).toHaveLength(2);
			const firstRecord = ydoc.getMap('records').get(recordIds[0]) as Y.Map<unknown>;
			expect(firstRecord.get('blockType')).toBe('paragraph');
			const secondRecord = ydoc.getMap('records').get(recordIds[1]) as Y.Map<unknown>;
			expect(secondRecord.get('blockType')).toBe('bulleted_list_item');
			expect(textOf(recordIds[1])).toBe('Milk');
		});
	});

	describe('Backspace: joining text onto the previous block, or deleting an empty one', () => {
		it('deletes an empty block on Backspace at the start and focuses the previous block', async () => {
			const first = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
			getRecordYText(ydoc, first.id)!.insert(0, 'First');
			createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
			const { container } = await renderDoc();

			const editors = container.querySelectorAll('[contenteditable]');
			const second = editors[1] as HTMLElement;
			second.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
			);

			expect(getDocument(ydoc, 'doc-1')?.recordIds).toHaveLength(1);
		});

		it('does not delete the only remaining block on Backspace', async () => {
			createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
			const { container } = await renderDoc();

			const editor = container.querySelector('[contenteditable]') as HTMLElement;
			editor.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
			);

			expect(getDocument(ydoc, 'doc-1')?.recordIds).toHaveLength(1);
		});

		it('joins a non-empty block onto the end of the previous one on Backspace at its start', async () => {
			const first = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
			getRecordYText(ydoc, first.id)!.insert(0, 'Hello');
			const second = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
			getRecordYText(ydoc, second.id)!.insert(0, ' world');
			const { container } = await renderDoc();

			const editors = container.querySelectorAll('[contenteditable]');
			selectRange(editors[1] as HTMLElement, 0, 0);
			(editors[1] as HTMLElement).dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
			);
			await tick();

			const recordIds = getDocument(ydoc, 'doc-1')!.recordIds;
			expect(recordIds).toHaveLength(1);
			expect(recordIds[0]).toBe(first.id);
			expect(textOf(first.id)).toBe('Hello world');
		});

		it('preserves marks from both blocks when joining them', async () => {
			const first = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
			getRecordYText(ydoc, first.id)!.insert(0, 'Hello', { bold: true });
			const second = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
			getRecordYText(ydoc, second.id)!.insert(0, ' world', { italic: true });
			const { container } = await renderDoc();

			const editors = container.querySelectorAll('[contenteditable]');
			selectRange(editors[1] as HTMLElement, 0, 0);
			(editors[1] as HTMLElement).dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
			);
			await tick();

			const delta = getRecordYText(ydoc, first.id)!.toDelta() as {
				insert: string;
				attributes?: { bold?: boolean; italic?: boolean };
			}[];
			expect(delta[0]).toMatchObject({ insert: 'Hello', attributes: { bold: true } });
			expect(delta[1]).toMatchObject({ insert: ' world', attributes: { italic: true } });
		});

		it('does not merge or delete a non-empty block when the previous block cannot hold text', async () => {
			createRecord(ydoc, { parentId: 'doc-1', blockType: 'divider' }, HUMAN);
			const second = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
			getRecordYText(ydoc, second.id)!.insert(0, 'Keep me');
			const { container } = await renderDoc();

			const editor = container.querySelector('[contenteditable]') as HTMLElement;
			selectRange(editor, 0, 0);
			editor.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
			);
			await tick();

			const recordIds = getDocument(ydoc, 'doc-1')!.recordIds;
			expect(recordIds).toHaveLength(2);
			expect(textOf(second.id)).toBe('Keep me');
		});
	});
});
