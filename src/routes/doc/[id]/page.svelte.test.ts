import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { createDocument, createRecord, getDocument, getRecordYText } from '$lib/data/records';
import type { ActorId } from '$lib/data/types';
import Page from './+page.svelte';

const HUMAN: ActorId = { kind: 'human', userId: 'local' };

function selectRange(el: HTMLElement, start: number, end: number): void {
	const textNode = el.firstChild as Text;
	const range = document.createRange();
	range.setStart(textNode, start);
	range.setEnd(textNode, end);
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
vi.mock('$lib/client/yjs-client', () => ({ getClientDoc: () => ydoc }));

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

describe('doc/[id] +page', () => {
	beforeEach(() => {
		ydoc = new Y.Doc();
		claimBlockPresence.mockClear();
		releaseBlockPresence.mockClear();
		subscribeHeldByOthers.mockClear().mockImplementation(() => () => {});
	});

	afterEach(() => {
		ydoc.destroy();
	});

	it('shows a prompt to start writing when the document has no blocks', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'Empty Doc' });
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'Empty Doc' }
		});
		expect(screen.getByText("Type '/' for commands, or start typing...")).toBeInTheDocument();
	});

	it('creates a first block when the empty-state prompt is clicked', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'Empty Doc' });
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'Empty Doc' }
		});

		await user.click(
			screen.getByText("Type '/' for commands, or start typing...", { selector: 'button' })
		);

		expect(screen.queryByRole('button', { name: /start typing/ })).not.toBeInTheDocument();
		expect(screen.getByRole('textbox', { name: /Block content|Type/ })).toBeInTheDocument();
	});

	it('inserts a block directly from the persistent toolbar', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		await user.click(screen.getByRole('button', { name: 'Insert Table' }));

		const doc = getDocument(ydoc, 'doc-1')!;
		expect(doc.recordIds).toHaveLength(1);
		expect((ydoc.getMap('records').get(doc.recordIds[0]) as Y.Map<unknown>).get('blockType')).toBe(
			'table'
		);
	});

	it('formats the active text selection directly from the persistent toolbar', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const record = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		getRecordYText(ydoc, record.id)!.insert(0, 'Hello');
		const user = userEvent.setup();
		const { container } = render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

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
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const record = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		getRecordYText(ydoc, record.id)!.insert(0, 'Hello');
		const user = userEvent.setup();
		const { container } = render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		const editor = container.querySelector('[contenteditable]') as HTMLElement;
		await user.click(editor);
		expect(screen.getByRole('button', { name: 'Bold' })).not.toBeDisabled();

		// e.g. the title input or the sidebar — anywhere without a block
		// editor ancestor. The previously focused block must stop being
		// treated as active, or a stray click on a format control would
		// silently reformat text the user can no longer see is "selected".
		clearSelection();
		await tick();

		expect(screen.getByRole('button', { name: 'Bold' })).toBeDisabled();
	});

	it('keeps the active block through a toolbar insert click, inserting after it rather than at the end', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const first = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		const middle = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		getRecordYText(ydoc, first.id)!.insert(0, 'First');
		getRecordYText(ydoc, middle.id)!.insert(0, 'Middle');
		const user = userEvent.setup();
		const { container } = render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

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

	it('renders the SSR title before mount, then the live document title', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'Live Title' });
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'SSR Title' }
		});
		expect(screen.getByDisplayValue('Live Title')).toBeInTheDocument();
	});

	it('updates the document title in the Y.Doc as the title input changes', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'Old' });
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'Old' }
		});

		const titleInput = screen.getByDisplayValue('Old');
		await user.clear(titleInput);
		await user.type(titleInput, 'New Title');

		expect(getDocument(ydoc, 'doc-1')?.title).toBe('New Title');
	});

	it('shows the parent document breadcrumb for a sub-page', () => {
		createDocument(ydoc, { id: 'parent', title: 'Parent Doc' });
		createDocument(ydoc, { id: 'child', title: 'Child Doc', parentDocumentId: 'parent' });
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'child', title: 'Child Doc' }
		});
		expect(screen.getByText('Parent Doc')).toBeInTheDocument();
	});

	it('renders a paragraph block with its text content', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const record = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		getRecordYText(ydoc, record.id)!.insert(0, 'Hello block');
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});
		expect(screen.getByText('Hello block')).toBeInTheDocument();
	});

	it('renders a to_do block with a checkbox toggle reflecting checked state', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const record = createRecord(ydoc, { parentId: 'doc-1', blockType: 'to_do' }, HUMAN);
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		const toggle = screen.getByRole('button', { name: 'Mark as complete' });
		await user.click(toggle);

		expect(screen.getByRole('button', { name: 'Mark as incomplete' })).toBeInTheDocument();
		expect(getDocument(ydoc, 'doc-1')).toBeDefined();
		const yrecord = ydoc.getMap('records').get(record.id) as Y.Map<unknown>;
		expect(yrecord.get('checked')).toBe(true);
	});

	it('renders a divider block', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'divider' }, HUMAN);
		const { container } = render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});
		expect(container.querySelector('.border-t.border-border')).toBeInTheDocument();
	});

	it('renders a callout block with its icon and text', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const record = createRecord(ydoc, { parentId: 'doc-1', blockType: 'callout' }, HUMAN);
		getRecordYText(ydoc, record.id)!.insert(0, 'Careful!');
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});
		expect(screen.getByText('Careful!')).toBeInTheDocument();
	});

	it('toggles a toggle block collapsed state', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const record = createRecord(ydoc, { parentId: 'doc-1', blockType: 'toggle' }, HUMAN);
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		await user.click(screen.getByRole('button', { name: 'Collapse section' }));

		const yrecord = ydoc.getMap('records').get(record.id) as Y.Map<unknown>;
		expect(yrecord.get('collapsed')).toBe(true);
	});

	it('renders a table of contents block listing heading blocks', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const h1 = createRecord(ydoc, { parentId: 'doc-1', blockType: 'heading_1' }, HUMAN);
		getRecordYText(ydoc, h1.id)!.insert(0, 'Section One');
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'table_of_contents' }, HUMAN);
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		expect(screen.getAllByText('Table of contents').length).toBeGreaterThan(0);
		expect(screen.getAllByText('Section One').length).toBeGreaterThan(0);
	});

	it('shows a set-target prompt for a synced block with no target yet', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'synced_block' }, HUMAN);
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});
		expect(screen.getByText('Set target ID')).toBeInTheDocument();
	});

	it('links a synced block to another record via a prompt', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const target = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		getRecordYText(ydoc, target.id)!.insert(0, 'Original content');
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'synced_block' }, HUMAN);
		vi.spyOn(window, 'prompt').mockReturnValue(target.id);
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		await user.click(screen.getByText('Set target ID'));

		expect(screen.getAllByText('Original content').length).toBeGreaterThan(0);
	});

	it('shows a document picker for an unlinked page_link block', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		createDocument(ydoc, { id: 'other', title: 'Other Doc' });
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'page_link' }, HUMAN);
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});
		expect(screen.getByText('Link to page:')).toBeInTheDocument();
		expect(screen.getByRole('option', { name: 'Other Doc' })).toBeInTheDocument();
	});

	it('renders a linked page_link block as a navigable link to the target document', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		createDocument(ydoc, { id: 'other', title: 'Other Doc' });
		createRecord(
			ydoc,
			{ parentId: 'doc-1', blockType: 'page_link', referencedRecordId: 'other' },
			HUMAN
		);
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});
		expect(screen.getByRole('link', { name: /Other Doc/ })).toHaveAttribute('href', '/doc/other');
	});

	it('adds a new block from the "Add block" button at the bottom', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		await user.click(screen.getByRole('button', { name: 'Add block' }));

		expect(getDocument(ydoc, 'doc-1')?.recordIds).toHaveLength(2);
	});

	it('opens the slash menu when a block is typed to "/", and applies the chosen block type', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		const user = userEvent.setup();
		const { container } = render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		const editor = container.querySelector('[contenteditable]') as HTMLElement;
		editor.textContent = '/';
		await editor.dispatchEvent(new InputEvent('input', { bubbles: true }));

		expect(screen.getByRole('listbox', { name: 'Slash commands' })).toBeInTheDocument();

		await user.click(within(screen.getByRole('listbox')).getByText('Heading 1'));

		expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
		const doc = getDocument(ydoc, 'doc-1')!;
		const yrecord = ydoc.getMap('records').get(doc.recordIds[0]) as Y.Map<unknown>;
		expect(yrecord.get('blockType')).toBe('heading_1');
	});

	it('shows a placeholder row instead of the editor for a block held by another actor', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const record = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		subscribeHeldByOthers.mockImplementation((onChange: (held: Map<string, ActorId>) => void) => {
			onChange(new Map([[record.id, { kind: 'agent', agentId: 'a1', name: 'Claude' }]]));
			return () => {};
		});

		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		expect(screen.getByText('Claude editing…')).toBeInTheDocument();
	});

	it('re-derives blocks when navigating client-side to a different document id', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'First' });
		const rec1 = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		getRecordYText(ydoc, rec1.id)!.insert(0, 'From doc one');

		createDocument(ydoc, { id: 'doc-2', title: 'Second' });
		const rec2 = createRecord(ydoc, { parentId: 'doc-2', blockType: 'paragraph' }, HUMAN);
		getRecordYText(ydoc, rec2.id)!.insert(0, 'From doc two');

		const user = userEvent.setup();
		const { container, rerender } = render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'First' }
		});
		expect(screen.getByText('From doc one')).toBeInTheDocument();
		await user.click(container.querySelector('[contenteditable]') as HTMLElement);

		await rerender({
			data: { documents: [], collections: [], documentId: 'doc-2', title: 'Second' }
		});

		expect(screen.queryByText('From doc one')).not.toBeInTheDocument();
		expect(screen.getByText('From doc two')).toBeInTheDocument();
	});

	it('claims block presence on focus and releases it on unmount', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		const user = userEvent.setup();
		const { container, unmount } = render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		const editor = container.querySelector('[contenteditable]') as HTMLElement;
		await user.click(editor);
		expect(claimBlockPresence).toHaveBeenCalled();

		unmount();
		expect(releaseBlockPresence).toHaveBeenCalledOnce();
	});

	it('renders a quote block and a code block with their text', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const quote = createRecord(ydoc, { parentId: 'doc-1', blockType: 'quote' }, HUMAN);
		getRecordYText(ydoc, quote.id)!.insert(0, 'A quote');
		const code = createRecord(ydoc, { parentId: 'doc-1', blockType: 'code' }, HUMAN);
		getRecordYText(ydoc, code.id)!.insert(0, 'const x = 1;');

		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		expect(screen.getByText('A quote')).toBeInTheDocument();
		expect(screen.getByText('const x = 1;')).toBeInTheDocument();
	});

	it('numbers sequential numbered_list_item blocks starting from 1', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'numbered_list_item' }, HUMAN);
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'numbered_list_item' }, HUMAN);
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'bulleted_list_item' }, HUMAN);

		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		expect(screen.getByText('1.')).toBeInTheDocument();
		expect(screen.getByText('2.')).toBeInTheDocument();
	});

	it('deletes a block on Backspace at the start and focuses the previous block', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const first = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		getRecordYText(ydoc, first.id)!.insert(0, 'First');
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		const { container } = render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		const editors = container.querySelectorAll('[contenteditable]');
		const second = editors[1] as HTMLElement;
		second.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
		);

		expect(getDocument(ydoc, 'doc-1')?.recordIds).toHaveLength(1);
	});

	it.each([
		['bulleted_list_item', 'Milk'],
		['numbered_list_item', 'Eggs'],
		['to_do', 'Bread']
	] as const)('continues a %s on Enter when the current item has text', async (blockType, text) => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const record = createRecord(ydoc, { parentId: 'doc-1', blockType }, HUMAN);
		getRecordYText(ydoc, record.id)!.insert(0, text);
		const { container } = render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		const editor = container.querySelector('[contenteditable]') as HTMLElement;
		editor.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
		);
		await tick();

		const recordIds = getDocument(ydoc, 'doc-1')!.recordIds;
		expect(recordIds).toHaveLength(2);
		const newRecord = ydoc.getMap('records').get(recordIds[1]) as Y.Map<unknown>;
		expect(newRecord.get('blockType')).toBe(blockType);
	});

	it.each(['bulleted_list_item', 'numbered_list_item', 'to_do'] as const)(
		'exits a %s on Enter when the current item is empty, converting it to a paragraph in place',
		async (blockType) => {
			createDocument(ydoc, { id: 'doc-1', title: 'D' });
			const record = createRecord(ydoc, { parentId: 'doc-1', blockType }, HUMAN);
			const { container } = render(Page, {
				params: { id: 'doc-1' },
				form: null,
				data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
			});

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

	it('does not delete the only remaining block on Backspace', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		const { container } = render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		const editor = container.querySelector('[contenteditable]') as HTMLElement;
		editor.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
		);

		expect(getDocument(ydoc, 'doc-1')?.recordIds).toHaveLength(1);
	});

	it('moves focus into the first block when Enter is pressed in the title, creating one if needed', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		const titleInput = screen.getByPlaceholderText('Untitled document');
		titleInput.focus();
		await user.keyboard('{Enter}');

		expect(getDocument(ydoc, 'doc-1')?.recordIds).toHaveLength(1);
	});

	it('focuses the last block when clicking the empty canvas area below existing blocks', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		const user = userEvent.setup();
		const { container } = render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		const canvas = container.querySelector('.cursor-text.flex-col') as HTMLElement;
		await user.click(canvas);

		expect(getDocument(ydoc, 'doc-1')?.recordIds).toHaveLength(1);
	});

	it('does not set a synced-block target when the prompt is cancelled', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const record = createRecord(ydoc, { parentId: 'doc-1', blockType: 'synced_block' }, HUMAN);
		vi.spyOn(window, 'prompt').mockReturnValue(null);
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		await user.click(screen.getByText('Set target ID'));

		const yrecord = ydoc.getMap('records').get(record.id) as Y.Map<unknown>;
		expect(yrecord.get('referencedRecordId')).toBeUndefined();
	});

	it('changes the target of an already-linked page_link block', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		createDocument(ydoc, { id: 'target-a', title: 'Target A' });
		createDocument(ydoc, { id: 'target-b', title: 'Target B' });
		const record = createRecord(
			ydoc,
			{ parentId: 'doc-1', blockType: 'page_link', referencedRecordId: 'target-a' },
			HUMAN
		);
		vi.spyOn(window, 'prompt').mockReturnValue('target-b');
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		await user.click(screen.getByText('Change'));

		const yrecord = ydoc.getMap('records').get(record.id) as Y.Map<unknown>;
		expect(yrecord.get('referencedRecordId')).toBe('target-b');
	});
});
