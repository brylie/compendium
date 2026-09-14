import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import * as Y from 'yjs';
import { createDocument } from '$lib/data/document-ops';
import {
	createRecord,
	getRecord,
	getRecordYText,
	listRecordsForParent
} from '$lib/data/record-ops';
import type { ActorId } from '$lib/data/types';
import ToggleChildren from './ToggleChildren.svelte';

const actor: ActorId = { kind: 'human', userId: 'local' };

function baseProps(ydoc: Y.Doc, block: ReturnType<typeof createRecord>) {
	return {
		block,
		ydoc,
		linkTargets: new Map(),
		blockRefs: {},
		draggingBlockId: null,
		dropIndicatorParentId: null,
		dropIndicatorIndex: null,
		selectedBlockIds: new Set<string>(),
		justNavigatedBlockId: null,
		convertOptions: [],
		onFocusBlock: vi.fn(),
		onInputText: vi.fn(),
		onDragHandlePointerDown: vi.fn(),
		onDragHandleKeydown: vi.fn(),
		onDuplicateBlock: vi.fn(),
		onDeleteBlock: vi.fn(),
		onConvertBlock: vi.fn(),
		onCopyBlockLink: vi.fn(),
		onMoveBlockUp: vi.fn(),
		onMoveBlockDown: vi.fn()
	};
}

function createToggle(ydoc: Y.Doc) {
	const doc = createDocument(ydoc, { title: 'D' });
	return createRecord(ydoc, { parentId: doc.id, blockType: 'toggle' }, actor);
}

describe('ToggleChildren (#227)', () => {
	it('renders no rows for a fresh toggle with zero children', () => {
		const ydoc = new Y.Doc();
		const toggle = createToggle(ydoc);

		const { container } = render(ToggleChildren, baseProps(ydoc, toggle));

		expect(container.querySelectorAll('[data-block-row]')).toHaveLength(0);
	});

	it('renders each child as its own editor', () => {
		const ydoc = new Y.Doc();
		const toggle = createToggle(ydoc);
		const child = createRecord(ydoc, { parentId: toggle.id, blockType: 'paragraph' }, actor);

		render(ToggleChildren, baseProps(ydoc, getRecord(ydoc, toggle.id)!));

		expect(document.querySelector(`[data-block-editor-id="${child.id}"]`)).toBeInTheDocument();
	});

	it('Enter on a child creates a new paragraph right after it', async () => {
		const ydoc = new Y.Doc();
		const toggle = createToggle(ydoc);
		const child = createRecord(ydoc, { parentId: toggle.id, blockType: 'paragraph' }, actor);

		render(ToggleChildren, baseProps(ydoc, getRecord(ydoc, toggle.id)!));
		const editor = document.querySelector(`[data-block-editor-id="${child.id}"]`) as HTMLElement;
		editor.focus();
		await fireEvent.keyDown(editor, { key: 'Enter' });

		expect(getRecord(ydoc, toggle.id)!.childRecordIds).toHaveLength(2);
	});

	it('Enter on a non-empty list item continues the list with the same block type', async () => {
		const ydoc = new Y.Doc();
		const toggle = createToggle(ydoc);
		const item = createRecord(
			ydoc,
			{ parentId: toggle.id, blockType: 'bulleted_list_item' },
			actor
		);
		getRecordYText(ydoc, item.id)!.insert(0, 'first item');

		render(ToggleChildren, baseProps(ydoc, getRecord(ydoc, toggle.id)!));
		const editor = document.querySelector(`[data-block-editor-id="${item.id}"]`) as HTMLElement;
		editor.focus();
		await fireEvent.keyDown(editor, { key: 'Enter' });

		const siblings = listRecordsForParent(ydoc, toggle.id);
		expect(siblings.at(-1)!.blockType).toBe('bulleted_list_item');
	});

	it('Enter on an empty list item exits the list, converting it to a paragraph in place', async () => {
		const ydoc = new Y.Doc();
		const toggle = createToggle(ydoc);
		const item = createRecord(
			ydoc,
			{ parentId: toggle.id, blockType: 'bulleted_list_item' },
			actor
		);

		render(ToggleChildren, baseProps(ydoc, getRecord(ydoc, toggle.id)!));
		const editor = document.querySelector(`[data-block-editor-id="${item.id}"]`) as HTMLElement;
		editor.focus();
		await fireEvent.keyDown(editor, { key: 'Enter' });

		expect(getRecord(ydoc, item.id)!.blockType).toBe('paragraph');
		expect(getRecord(ydoc, toggle.id)!.childRecordIds).toHaveLength(1); // converted in place, no new block added
	});

	it('Backspace on an empty, non-first child deletes it and focuses the previous one', async () => {
		const ydoc = new Y.Doc();
		const toggle = createToggle(ydoc);
		const first = createRecord(ydoc, { parentId: toggle.id, blockType: 'paragraph' }, actor);
		const second = createRecord(ydoc, { parentId: toggle.id, blockType: 'paragraph' }, actor);

		render(ToggleChildren, baseProps(ydoc, getRecord(ydoc, toggle.id)!));
		const editor = document.querySelector(`[data-block-editor-id="${second.id}"]`) as HTMLElement;
		editor.focus();
		await fireEvent.keyDown(editor, { key: 'Backspace' });

		expect(getRecord(ydoc, second.id)).toBeUndefined();
		expect(getRecord(ydoc, toggle.id)!.childRecordIds).toEqual([first.id]);
	});

	it('Backspace on the first child does nothing special — it does not collapse the toggle', async () => {
		const ydoc = new Y.Doc();
		const toggle = createToggle(ydoc);
		const first = createRecord(ydoc, { parentId: toggle.id, blockType: 'paragraph' }, actor);

		render(ToggleChildren, baseProps(ydoc, getRecord(ydoc, toggle.id)!));
		const editor = document.querySelector(`[data-block-editor-id="${first.id}"]`) as HTMLElement;
		editor.focus();
		await fireEvent.keyDown(editor, { key: 'Backspace' });

		expect(getRecord(ydoc, first.id)).toBeDefined();
		expect(getRecord(ydoc, toggle.id)!.childRecordIds).toEqual([first.id]);
		expect(getRecord(ydoc, toggle.id)!.blockType).toBe('toggle');
	});

	it('the "Add block" control adds a paragraph at the end of the toggle', async () => {
		const ydoc = new Y.Doc();
		const toggle = createToggle(ydoc);
		createRecord(ydoc, { parentId: toggle.id, blockType: 'paragraph' }, actor);

		render(ToggleChildren, baseProps(ydoc, getRecord(ydoc, toggle.id)!));
		await fireEvent.click(screen.getByRole('button', { name: 'Add block' }));

		expect(getRecord(ydoc, toggle.id)!.childRecordIds).toHaveLength(2);
	});

	it('shows a drop indicator only when dragging over this toggle at the matching index', async () => {
		const ydoc = new Y.Doc();
		const toggle = createToggle(ydoc);
		createRecord(ydoc, { parentId: toggle.id, blockType: 'paragraph' }, actor);

		const { container, rerender } = render(ToggleChildren, {
			...baseProps(ydoc, getRecord(ydoc, toggle.id)!),
			draggingBlockId: 'some-block',
			dropIndicatorParentId: 'a-different-container',
			dropIndicatorIndex: 0
		});
		expect(
			container.querySelector(`[data-block-container="${toggle.id}"] .drop-indicator`)
		).not.toBeInTheDocument();

		await rerender({
			...baseProps(ydoc, getRecord(ydoc, toggle.id)!),
			draggingBlockId: 'some-block',
			dropIndicatorParentId: toggle.id,
			dropIndicatorIndex: 0
		});
		expect(
			container.querySelector(`[data-block-container="${toggle.id}"] .drop-indicator`)
		).toBeInTheDocument();
	});

	it('invokes the drag-handle pointerdown/keydown callbacks with the block, toggle id, and index', async () => {
		const ydoc = new Y.Doc();
		const toggle = createToggle(ydoc);
		const child = createRecord(ydoc, { parentId: toggle.id, blockType: 'paragraph' }, actor);
		const props = baseProps(ydoc, getRecord(ydoc, toggle.id)!);

		render(ToggleChildren, props);
		const handle = document.querySelector(`[data-drag-handle="${child.id}"]`) as HTMLButtonElement;
		await fireEvent.pointerDown(handle, { button: 0 });
		expect(props.onDragHandlePointerDown).toHaveBeenCalledWith(
			expect.anything(),
			child.id,
			toggle.id,
			0
		);

		await fireEvent.keyDown(handle, { key: 'ArrowDown' });
		expect(props.onDragHandleKeydown).toHaveBeenCalledWith(expect.anything(), child.id);
	});

	it('calls onFocusBlock when a toggle child editor is focused', () => {
		const ydoc = new Y.Doc();
		const toggle = createToggle(ydoc);
		const child = createRecord(ydoc, { parentId: toggle.id, blockType: 'paragraph' }, actor);
		const props = baseProps(ydoc, getRecord(ydoc, toggle.id)!);

		render(ToggleChildren, props);
		const editor = document.querySelector(`[data-block-editor-id="${child.id}"]`) as HTMLElement;
		editor.focus();

		expect(props.onFocusBlock).toHaveBeenCalledWith(child.id);
	});

	it('calls onInputText with the child id when a toggle child is typed into', async () => {
		const ydoc = new Y.Doc();
		const toggle = createToggle(ydoc);
		const child = createRecord(ydoc, { parentId: toggle.id, blockType: 'paragraph' }, actor);
		const props = baseProps(ydoc, getRecord(ydoc, toggle.id)!);

		render(ToggleChildren, props);
		const editor = document.querySelector(`[data-block-editor-id="${child.id}"]`) as HTMLElement;
		editor.textContent = 'hi';
		await fireEvent.input(editor);

		expect(props.onInputText).toHaveBeenCalledWith(child.id);
	});
});
