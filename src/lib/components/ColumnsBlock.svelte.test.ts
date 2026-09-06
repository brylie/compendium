import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import * as Y from 'yjs';
import { createDocument } from '$lib/data/document-ops';
import {
	createColumnsBlock,
	createRecord,
	getRecord,
	getRecordYText,
	listRecordsForParent
} from '$lib/data/record-ops';
import type { ActorId } from '$lib/data/types';
import ColumnsBlock from './ColumnsBlock.svelte';

const actor: ActorId = { kind: 'human', userId: 'local' };

function baseProps(ydoc: Y.Doc, block: ReturnType<typeof createColumnsBlock>) {
	return {
		block,
		ydoc,
		linkTargets: new Map(),
		blockRefs: {},
		draggingBlockId: null,
		dropIndicatorParentId: null,
		dropIndicatorIndex: null,
		onFocusBlock: vi.fn(),
		onInputText: vi.fn(),
		onDragHandlePointerDown: vi.fn(),
		onDragHandleKeydown: vi.fn()
	};
}

describe('ColumnsBlock (#148)', () => {
	it('renders each column as a labeled group with its seeded paragraph editor', () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const columns = createColumnsBlock(ydoc, { parentId: doc.id }, actor);

		render(ColumnsBlock, baseProps(ydoc, columns));

		expect(screen.getByRole('group', { name: 'Column 1 of 2' })).toBeInTheDocument();
		expect(screen.getByRole('group', { name: 'Column 2 of 2' })).toBeInTheDocument();
		for (const columnId of columns.childRecordIds!) {
			const [paragraphId] = getRecord(ydoc, columnId)!.childRecordIds!;
			expect(document.querySelector(`[data-block-editor-id="${paragraphId}"]`)).toBeInTheDocument();
		}
	});

	it('renders a to_do block with a working checkbox toggle', async () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const columns = createColumnsBlock(ydoc, { parentId: doc.id }, actor);
		const [columnId] = columns.childRecordIds!;
		const [seeded] = getRecord(ydoc, columnId)!.childRecordIds!;
		// Reuse the seeded paragraph's slot as a to_do for this test.
		const todo = createRecord(ydoc, { parentId: columnId, blockType: 'to_do' }, actor);

		const { rerender } = render(ColumnsBlock, baseProps(ydoc, getRecord(ydoc, columns.id)!));

		const toggle = screen.getByRole('button', { name: 'Mark as complete' });
		await fireEvent.click(toggle);
		expect(getRecord(ydoc, todo.id)!.checked).toBe(true);

		// ColumnsBlock has no Yjs subscription of its own (see the component's
		// own comment) — it relies on +page.svelte re-passing a fresh `block`
		// prop after any mutation, including its own. Standalone, simulate
		// that hand-off explicitly rather than expecting self-reactivity.
		await rerender(baseProps(ydoc, getRecord(ydoc, columns.id)!));
		expect(screen.getByRole('button', { name: 'Mark as incomplete' })).toBeInTheDocument();

		expect(getRecord(ydoc, seeded)!.id).toBe(seeded); // seeded paragraph still present
	});

	it('renders bulleted and numbered list markers, numbering resetting after a non-numbered item', () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const columns = createColumnsBlock(ydoc, { parentId: doc.id }, actor);
		const [columnId] = columns.childRecordIds!;
		createRecord(ydoc, { parentId: columnId, blockType: 'bulleted_list_item' }, actor);
		createRecord(ydoc, { parentId: columnId, blockType: 'numbered_list_item' }, actor);
		createRecord(ydoc, { parentId: columnId, blockType: 'numbered_list_item' }, actor);
		createRecord(ydoc, { parentId: columnId, blockType: 'paragraph' }, actor);
		createRecord(ydoc, { parentId: columnId, blockType: 'numbered_list_item' }, actor);

		render(ColumnsBlock, baseProps(ydoc, getRecord(ydoc, columns.id)!));

		expect(screen.getByText('•')).toBeInTheDocument();
		const numbers = screen.getAllByText(/^\d+\.$/).map((el) => el.textContent);
		expect(numbers).toEqual(['1.', '2.', '1.']);
	});

	it('renders a quote block and a divider', () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const columns = createColumnsBlock(ydoc, { parentId: doc.id }, actor);
		const [columnId] = columns.childRecordIds!;
		createRecord(ydoc, { parentId: columnId, blockType: 'quote' }, actor);
		createRecord(ydoc, { parentId: columnId, blockType: 'divider' }, actor);

		const { container } = render(ColumnsBlock, baseProps(ydoc, getRecord(ydoc, columns.id)!));

		expect(container.querySelector('.italic')).toBeInTheDocument();
		expect(container.querySelector('.border-t.border-border')).toBeInTheDocument();
	});

	it('applies a distinct text class per heading level', () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const columns = createColumnsBlock(ydoc, { parentId: doc.id }, actor);
		const [columnId] = columns.childRecordIds!;
		const h1 = createRecord(ydoc, { parentId: columnId, blockType: 'heading_1' }, actor);
		const h4 = createRecord(ydoc, { parentId: columnId, blockType: 'heading_4' }, actor);

		render(ColumnsBlock, baseProps(ydoc, getRecord(ydoc, columns.id)!));

		const h1El = document.querySelector(`[data-block-editor-id="${h1.id}"]`)!;
		const h4El = document.querySelector(`[data-block-editor-id="${h4.id}"]`)!;
		expect(h1El.className).toContain('text-2xl');
		expect(h4El.className).toContain('text-base');
	});

	it('Enter on a non-list block creates a new paragraph after it in the same column', async () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const columns = createColumnsBlock(ydoc, { parentId: doc.id }, actor);
		const [columnId] = columns.childRecordIds!;
		const [paragraphId] = getRecord(ydoc, columnId)!.childRecordIds!;

		render(ColumnsBlock, baseProps(ydoc, getRecord(ydoc, columns.id)!));
		const editor = document.querySelector(`[data-block-editor-id="${paragraphId}"]`) as HTMLElement;
		editor.focus();
		await fireEvent.keyDown(editor, { key: 'Enter' });

		expect(getRecord(ydoc, columnId)!.childRecordIds).toHaveLength(2);
	});

	it('Enter on a non-empty list item continues the list with the same block type', async () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const columns = createColumnsBlock(ydoc, { parentId: doc.id }, actor);
		const [columnId] = columns.childRecordIds!;
		const item = createRecord(ydoc, { parentId: columnId, blockType: 'bulleted_list_item' }, actor);
		getRecordYText(ydoc, item.id)!.insert(0, 'first item');

		render(ColumnsBlock, baseProps(ydoc, getRecord(ydoc, columns.id)!));
		const editor = document.querySelector(`[data-block-editor-id="${item.id}"]`) as HTMLElement;
		editor.focus();
		await fireEvent.keyDown(editor, { key: 'Enter' });

		const siblings = listRecordsForParent(ydoc, columnId);
		expect(siblings.at(-1)!.blockType).toBe('bulleted_list_item');
	});

	it('Enter on an empty list item exits the list, converting it to a paragraph in place', async () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const columns = createColumnsBlock(ydoc, { parentId: doc.id }, actor);
		const [columnId] = columns.childRecordIds!;
		const item = createRecord(ydoc, { parentId: columnId, blockType: 'bulleted_list_item' }, actor);

		render(ColumnsBlock, baseProps(ydoc, getRecord(ydoc, columns.id)!));
		const editor = document.querySelector(`[data-block-editor-id="${item.id}"]`) as HTMLElement;
		editor.focus();
		await fireEvent.keyDown(editor, { key: 'Enter' });

		expect(getRecord(ydoc, item.id)!.blockType).toBe('paragraph');
		expect(getRecord(ydoc, columnId)!.childRecordIds).toHaveLength(2); // seeded paragraph + item, no new block added
	});

	it('Backspace on an empty, non-first block deletes it and focuses the previous block', async () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const columns = createColumnsBlock(ydoc, { parentId: doc.id }, actor);
		const [columnId] = columns.childRecordIds!;
		const [first] = getRecord(ydoc, columnId)!.childRecordIds!;
		const second = createRecord(ydoc, { parentId: columnId, blockType: 'paragraph' }, actor);

		render(ColumnsBlock, baseProps(ydoc, getRecord(ydoc, columns.id)!));
		const editor = document.querySelector(`[data-block-editor-id="${second.id}"]`) as HTMLElement;
		editor.focus();
		await fireEvent.keyDown(editor, { key: 'Backspace' });

		expect(getRecord(ydoc, second.id)).toBeUndefined();
		expect(getRecord(ydoc, columnId)!.childRecordIds).toEqual([first]);
	});

	it('Backspace on a non-empty block does not delete it', async () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const columns = createColumnsBlock(ydoc, { parentId: doc.id }, actor);
		const [columnId] = columns.childRecordIds!;
		const second = createRecord(ydoc, { parentId: columnId, blockType: 'paragraph' }, actor);
		getRecordYText(ydoc, second.id)!.insert(0, 'not empty');

		render(ColumnsBlock, baseProps(ydoc, getRecord(ydoc, columns.id)!));
		const editor = document.querySelector(`[data-block-editor-id="${second.id}"]`) as HTMLElement;
		editor.focus();
		await fireEvent.keyDown(editor, { key: 'Backspace' });

		expect(getRecord(ydoc, second.id)).toBeDefined();
	});

	it('Backspace on the first block of a column is a no-op', async () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const columns = createColumnsBlock(ydoc, { parentId: doc.id }, actor);
		const [columnId] = columns.childRecordIds!;
		const [first] = getRecord(ydoc, columnId)!.childRecordIds!;

		render(ColumnsBlock, baseProps(ydoc, getRecord(ydoc, columns.id)!));
		const editor = document.querySelector(`[data-block-editor-id="${first}"]`) as HTMLElement;
		editor.focus();
		await fireEvent.keyDown(editor, { key: 'Backspace' });

		expect(getRecord(ydoc, first)).toBeDefined();
		expect(getRecord(ydoc, columnId)!.childRecordIds).toEqual([first]);
	});

	it('the "Add block" control adds a paragraph at the end of that column', async () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const columns = createColumnsBlock(ydoc, { parentId: doc.id }, actor);
		const [columnId] = columns.childRecordIds!;

		render(ColumnsBlock, baseProps(ydoc, getRecord(ydoc, columns.id)!));
		const [addBlockButton] = screen.getAllByRole('button', { name: 'Add block' });
		await fireEvent.click(addBlockButton);

		expect(getRecord(ydoc, columnId)!.childRecordIds).toHaveLength(2);
	});

	it('the "Add column" control adds another column; "Remove column" removes one once there are more than 2', async () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const columns = createColumnsBlock(ydoc, { parentId: doc.id }, actor);

		const { rerender } = render(ColumnsBlock, baseProps(ydoc, getRecord(ydoc, columns.id)!));
		expect(screen.queryByRole('button', { name: /^Remove column/ })).not.toBeInTheDocument();

		await fireEvent.click(screen.getByRole('button', { name: 'Add column' }));
		expect(getRecord(ydoc, columns.id)!.childRecordIds).toHaveLength(3);
		// See the to_do test's comment — simulate the parent's prop hand-off.
		await rerender(baseProps(ydoc, getRecord(ydoc, columns.id)!));
		expect(screen.getByRole('button', { name: 'Remove column 3' })).toBeInTheDocument();

		await fireEvent.click(screen.getByRole('button', { name: 'Remove column 3' }));
		expect(getRecord(ydoc, columns.id)!.childRecordIds).toHaveLength(2);
	});

	it('shows a drop indicator only for the matching container/index and not elsewhere', async () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const columns = createColumnsBlock(ydoc, { parentId: doc.id }, actor);
		const [columnAId, columnBId] = columns.childRecordIds!;

		const { container, rerender } = render(ColumnsBlock, {
			...baseProps(ydoc, getRecord(ydoc, columns.id)!),
			draggingBlockId: 'some-block',
			dropIndicatorParentId: columnAId,
			dropIndicatorIndex: 0
		});
		expect(
			container.querySelector(`[data-block-container="${columnAId}"] .drop-indicator`)
		).toBeInTheDocument();
		expect(
			container.querySelector(`[data-block-container="${columnBId}"] .drop-indicator`)
		).not.toBeInTheDocument();

		await rerender({
			...baseProps(ydoc, getRecord(ydoc, columns.id)!),
			draggingBlockId: 'some-block',
			dropIndicatorParentId: columnBId,
			dropIndicatorIndex: 1 // column B has 1 seeded block — matches the trailing indicator
		});
		expect(
			container.querySelector(`[data-block-container="${columnBId}"] .drop-indicator`)
		).toBeInTheDocument();
		expect(
			container.querySelector(`[data-block-container="${columnAId}"] .drop-indicator`)
		).not.toBeInTheDocument();
	});

	it('invokes the drag-handle pointerdown/keydown callbacks with the block, column, and index', async () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const columns = createColumnsBlock(ydoc, { parentId: doc.id }, actor);
		const [columnId] = columns.childRecordIds!;
		const [blockId] = getRecord(ydoc, columnId)!.childRecordIds!;
		const props = baseProps(ydoc, getRecord(ydoc, columns.id)!);

		render(ColumnsBlock, props);
		const handle = document.querySelector(`[data-drag-handle="${blockId}"]`) as HTMLButtonElement;
		await fireEvent.pointerDown(handle, { button: 0 });
		expect(props.onDragHandlePointerDown).toHaveBeenCalledWith(
			expect.anything(),
			blockId,
			columnId,
			0
		);

		await fireEvent.keyDown(handle, { key: 'ArrowRight' });
		expect(props.onDragHandleKeydown).toHaveBeenCalledWith(expect.anything(), blockId);
	});

	it('calls onFocusBlock when a column block editor is focused', async () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const columns = createColumnsBlock(ydoc, { parentId: doc.id }, actor);
		const [columnId] = columns.childRecordIds!;
		const [blockId] = getRecord(ydoc, columnId)!.childRecordIds!;
		const props = baseProps(ydoc, getRecord(ydoc, columns.id)!);

		render(ColumnsBlock, props);
		const editor = document.querySelector(`[data-block-editor-id="${blockId}"]`) as HTMLElement;
		editor.focus();

		expect(props.onFocusBlock).toHaveBeenCalledWith(blockId);
	});

	it('calls onInputText with the block id when a column block is typed into', async () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const columns = createColumnsBlock(ydoc, { parentId: doc.id }, actor);
		const [columnId] = columns.childRecordIds!;
		const [blockId] = getRecord(ydoc, columnId)!.childRecordIds!;
		const props = baseProps(ydoc, getRecord(ydoc, columns.id)!);

		render(ColumnsBlock, props);
		const editor = document.querySelector(`[data-block-editor-id="${blockId}"]`) as HTMLElement;
		editor.textContent = 'hi';
		await fireEvent.input(editor);

		expect(props.onInputText).toHaveBeenCalledWith(blockId);
	});
});
