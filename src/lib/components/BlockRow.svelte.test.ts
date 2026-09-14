import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import * as Y from 'yjs';
import { createDocument } from '$lib/data/document-ops';
import { createRecord, getRecord, getRecordYText } from '$lib/data/record-ops';
import type { ActorId, WorkspaceRecord } from '$lib/data/types';
import BlockRow from './BlockRow.svelte';

const actor: ActorId = { kind: 'human', userId: 'local' };

function baseProps(ydoc: Y.Doc, block: WorkspaceRecord, overrides: Record<string, unknown> = {}) {
	const siblings = (overrides.siblings as WorkspaceRecord[] | undefined) ?? [block];
	const index =
		(overrides.index as number | undefined) ?? siblings.findIndex((s) => s.id === block.id);
	return {
		block,
		index,
		siblings,
		parentId: block.parentId!,
		ydoc,
		ytext: getRecordYText(ydoc, block.id),
		linkTargets: new Map(),
		blockRefs: {},
		draggingBlockId: null,
		selectedBlockIds: new Set<string>(),
		justNavigatedBlockId: null,
		convertOptions: [],
		rowClass: 'flex items-start py-0.5',
		moveAriaLabel: 'Move block',
		placeholder: '',
		onDragHandlePointerDown: vi.fn(),
		onDragHandleKeydown: vi.fn(),
		onDuplicateBlock: vi.fn(),
		onDeleteBlock: vi.fn(),
		onConvertBlock: vi.fn(),
		onCopyBlockLink: vi.fn(),
		onMoveBlockUp: vi.fn(),
		onMoveBlockDown: vi.fn(),
		onFocusBlock: vi.fn(),
		onInputText: vi.fn(),
		onEnter: vi.fn(),
		onBackspaceAtStart: vi.fn(),
		onSlashKey: vi.fn(),
		...overrides
	};
}

function textSnippet(testId: string, text: string) {
	return createRawSnippet(() => ({
		render: () => `<span data-testid="${testId}">${text}</span>`
	}));
}

describe('BlockRow (#295)', () => {
	it('renders the move handle and forwards pointerdown/keydown to the drag-handle callbacks', async () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const block = createRecord(ydoc, { parentId: doc.id, blockType: 'paragraph' }, actor);
		const props = baseProps(ydoc, block, { index: 2 });

		render(BlockRow, props);
		const handle = screen.getByRole('button', { name: 'Move block' });

		await fireEvent.pointerDown(handle, { button: 0 });
		expect(props.onDragHandlePointerDown).toHaveBeenCalledWith(
			expect.anything(),
			block.id,
			doc.id,
			2
		);

		await fireEvent.keyDown(handle, { key: 'ArrowDown' });
		expect(props.onDragHandleKeydown).toHaveBeenCalledWith(expect.anything(), block.id);
	});

	it('wires the block action menu to duplicate/delete/convert/copy-link/move callbacks', async () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const block = createRecord(ydoc, { parentId: doc.id, blockType: 'paragraph' }, actor);
		const props = baseProps(ydoc, block, {
			convertOptions: [
				{ type: 'paragraph' as const, label: 'Text' },
				{ type: 'heading_1' as const, label: 'Heading 1' }
			]
		});
		const user = userEvent.setup();

		render(BlockRow, props);

		await user.click(screen.getByRole('button', { name: 'Block actions' }));
		await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
		expect(props.onDuplicateBlock).toHaveBeenCalledWith(block.id);

		await user.click(screen.getByRole('button', { name: 'Block actions' }));
		await user.click(screen.getByRole('menuitem', { name: 'Convert to…' }));
		await user.click(screen.getByRole('menuitem', { name: 'Heading 1' }));
		expect(props.onConvertBlock).toHaveBeenCalledWith(block.id, 'heading_1');

		await user.click(screen.getByRole('button', { name: 'Block actions' }));
		await user.click(screen.getByRole('menuitem', { name: 'Copy link to block' }));
		expect(props.onCopyBlockLink).toHaveBeenCalledWith(block.id);

		await user.click(screen.getByRole('button', { name: 'Block actions' }));
		await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
		expect(props.onDeleteBlock).toHaveBeenCalledWith(block.id);
	});

	it('disables Move up on the first block, Move down on the last, and calls the move callbacks otherwise', async () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const first = createRecord(ydoc, { parentId: doc.id, blockType: 'paragraph' }, actor);
		const second = createRecord(ydoc, { parentId: doc.id, blockType: 'paragraph' }, actor);
		const siblings = [first, second];
		const user = userEvent.setup();

		const { unmount } = render(BlockRow, baseProps(ydoc, first, { siblings, index: 0 }));
		await user.click(screen.getByRole('button', { name: 'Block actions' }));
		expect(screen.getByRole('menuitem', { name: 'Move up' })).toBeDisabled();
		unmount();

		const props = baseProps(ydoc, first, { siblings, index: 0 });
		render(BlockRow, props);
		await user.click(screen.getByRole('button', { name: 'Block actions' }));
		await user.click(screen.getByRole('menuitem', { name: 'Move down' }));
		expect(props.onMoveBlockDown).toHaveBeenCalledWith(first.id);
	});

	it('highlights a selected block, a just-navigated block, and a dragging block with distinct classes', () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const block = createRecord(ydoc, { parentId: doc.id, blockType: 'paragraph' }, actor);

		const { unmount } = render(
			BlockRow,
			baseProps(ydoc, block, { selectedBlockIds: new Set([block.id]) })
		);
		let row = document.getElementById(`block-${block.id}`) as HTMLElement;
		expect(row.className).toContain('bg-surface');
		expect(row.className).toContain('rounded');
		unmount();

		const { unmount: unmount2 } = render(
			BlockRow,
			baseProps(ydoc, block, { justNavigatedBlockId: block.id })
		);
		row = document.getElementById(`block-${block.id}`) as HTMLElement;
		expect(row.className).toContain('outline-accent');
		expect(row.className).toContain('rounded');
		unmount2();

		render(BlockRow, baseProps(ydoc, block, { draggingBlockId: block.id }));
		row = document.getElementById(`block-${block.id}`) as HTMLElement;
		expect(row.className).toContain('opacity-50');
	});

	it('renders a to_do checkbox that toggles the record and reflects the new state once re-passed', async () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const block = createRecord(ydoc, { parentId: doc.id, blockType: 'to_do' }, actor);

		const { rerender } = render(BlockRow, baseProps(ydoc, block));
		const toggle = screen.getByRole('button', { name: 'Mark as complete' });
		await fireEvent.click(toggle);

		expect(getRecord(ydoc, block.id)!.checked).toBe(true);

		// BlockRow has no Yjs subscription of its own — it relies on the
		// caller re-passing a fresh `block` prop after any mutation.
		await rerender(baseProps(ydoc, getRecord(ydoc, block.id)!));
		expect(screen.getByRole('button', { name: 'Mark as incomplete' })).toBeInTheDocument();
	});

	it('renders a bulleted list marker', () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const block = createRecord(ydoc, { parentId: doc.id, blockType: 'bulleted_list_item' }, actor);

		render(BlockRow, baseProps(ydoc, block));

		expect(screen.getByText('•')).toBeInTheDocument();
	});

	it('numbers a numbered_list_item by counting back over consecutive numbered siblings, resetting after a non-numbered one', () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const first = createRecord(ydoc, { parentId: doc.id, blockType: 'numbered_list_item' }, actor);
		const secondNum = createRecord(
			ydoc,
			{ parentId: doc.id, blockType: 'numbered_list_item' },
			actor
		);
		const middleParagraph = createRecord(ydoc, { parentId: doc.id, blockType: 'paragraph' }, actor);
		const resetNum = createRecord(
			ydoc,
			{ parentId: doc.id, blockType: 'numbered_list_item' },
			actor
		);
		const siblings = [first, secondNum, middleParagraph, resetNum];

		const { container: c1, unmount: u1 } = render(
			BlockRow,
			baseProps(ydoc, first, { siblings, index: 0 })
		);
		expect(within(c1).getByText('1.')).toBeInTheDocument();
		u1();

		const { container: c2, unmount: u2 } = render(
			BlockRow,
			baseProps(ydoc, secondNum, { siblings, index: 1 })
		);
		expect(within(c2).getByText('2.')).toBeInTheDocument();
		u2();

		const { container: c3 } = render(BlockRow, baseProps(ydoc, resetNum, { siblings, index: 3 }));
		expect(within(c3).getByText('1.')).toBeInTheDocument();
	});

	it('renders a toggle collapse/expand control only when onToggleCollapse is provided, and calls it with the block', async () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const block = createRecord(ydoc, { parentId: doc.id, blockType: 'toggle' }, actor);
		const onToggleCollapse = vi.fn();

		const { unmount } = render(BlockRow, baseProps(ydoc, block));
		expect(screen.queryByRole('button', { name: 'Collapse section' })).not.toBeInTheDocument();
		unmount();

		render(BlockRow, baseProps(ydoc, block, { onToggleCollapse }));
		const toggle = screen.getByRole('button', { name: 'Collapse section' });
		await fireEvent.click(toggle);
		expect(onToggleCollapse).toHaveBeenCalledWith(block);
	});

	it('shows "Expand section" for a collapsed toggle block', () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const block = createRecord(
			ydoc,
			{ parentId: doc.id, blockType: 'toggle', collapsed: true },
			actor
		);

		render(BlockRow, baseProps(ydoc, block, { onToggleCollapse: vi.fn() }));

		expect(screen.getByRole('button', { name: 'Expand section' })).toBeInTheDocument();
	});

	it('renders a divider without a text editor', () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const block = createRecord(ydoc, { parentId: doc.id, blockType: 'divider' }, actor);

		const { container } = render(BlockRow, baseProps(ydoc, block));

		expect(container.querySelector('.border-t.border-border')).toBeInTheDocument();
		expect(container.querySelector(`[data-block-editor-id="${block.id}"]`)).not.toBeInTheDocument();
	});

	it('renders a quote with its own placeholder inside an italic wrapper', () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const block = createRecord(ydoc, { parentId: doc.id, blockType: 'quote' }, actor);

		const { container } = render(BlockRow, baseProps(ydoc, block));

		expect(container.querySelector('.italic')).toBeInTheDocument();
		const editor = container.querySelector(`[data-block-editor-id="${block.id}"]`) as HTMLElement;
		expect(editor).toBeInTheDocument();
		expect(editor.getAttribute('aria-label')).toBe('Quote…');
	});

	it('applies a distinct text class per heading level for the default text dispatch', () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const h1 = createRecord(ydoc, { parentId: doc.id, blockType: 'heading_1' }, actor);
		const h4 = createRecord(ydoc, { parentId: doc.id, blockType: 'heading_4' }, actor);

		const { container: c1, unmount } = render(BlockRow, baseProps(ydoc, h1));
		const h1El = c1.querySelector(`[data-block-editor-id="${h1.id}"]`)!;
		expect(h1El.className).toContain('text-2xl');
		unmount();

		const { container: c2 } = render(BlockRow, baseProps(ydoc, h4));
		const h4El = c2.querySelector(`[data-block-editor-id="${h4.id}"]`)!;
		expect(h4El.className).toContain('text-base');
	});

	it('applies the passed placeholder to the default text editor', () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const block = createRecord(ydoc, { parentId: doc.id, blockType: 'paragraph' }, actor);

		render(BlockRow, baseProps(ydoc, block, { placeholder: 'Type something…' }));

		expect(screen.getByLabelText('Type something…')).toBeInTheDocument();
	});

	it('renders the held-actor placeholder instead of any editor when heldByActorLabel is set', () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const block = createRecord(ydoc, { parentId: doc.id, blockType: 'paragraph' }, actor);

		const { container } = render(BlockRow, baseProps(ydoc, block, { heldByActorLabel: 'Jordan' }));

		expect(screen.getByRole('group', { name: 'Jordan is editing this block' })).toBeInTheDocument();
		expect(screen.getByText('J')).toBeInTheDocument();
		expect(container.querySelector(`[data-block-editor-id="${block.id}"]`)).not.toBeInTheDocument();
	});

	it('renders the held-actor placeholder even for a divider or quote block', () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const block = createRecord(ydoc, { parentId: doc.id, blockType: 'divider' }, actor);

		const { container } = render(BlockRow, baseProps(ydoc, block, { heldByActorLabel: 'Ari' }));

		expect(screen.getByRole('group', { name: 'Ari is editing this block' })).toBeInTheDocument();
		expect(container.querySelector('.border-t.border-border')).not.toBeInTheDocument();
	});

	it('renders customContent for a block type included in customBlockTypes instead of the generic dispatch', () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const block = createRecord(ydoc, { parentId: doc.id, blockType: 'callout' }, actor);

		const { container } = render(
			BlockRow,
			baseProps(ydoc, block, {
				customBlockTypes: ['callout'],
				customContent: textSnippet('custom', 'Custom callout content')
			})
		);

		expect(screen.getByTestId('custom')).toHaveTextContent('Custom callout content');
		expect(container.querySelector(`[data-block-editor-id="${block.id}"]`)).not.toBeInTheDocument();
	});

	it('falls back to the generic text dispatch when the block type is not in customBlockTypes', () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const block = createRecord(ydoc, { parentId: doc.id, blockType: 'paragraph' }, actor);

		const { container } = render(
			BlockRow,
			baseProps(ydoc, block, {
				customBlockTypes: ['callout'],
				customContent: textSnippet('custom', 'Custom callout content')
			})
		);

		expect(screen.queryByTestId('custom')).not.toBeInTheDocument();
		expect(container.querySelector(`[data-block-editor-id="${block.id}"]`)).toBeInTheDocument();
	});

	it('renders trailingContent and insideContent when supplied, and omits them when absent', () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const block = createRecord(ydoc, { parentId: doc.id, blockType: 'paragraph' }, actor);

		const { unmount } = render(BlockRow, baseProps(ydoc, block));
		expect(screen.queryByTestId('trailing')).not.toBeInTheDocument();
		expect(screen.queryByTestId('inside')).not.toBeInTheDocument();
		unmount();

		render(
			BlockRow,
			baseProps(ydoc, block, {
				trailingContent: textSnippet('trailing', 'Trailing'),
				insideContent: textSnippet('inside', 'Inside')
			})
		);
		expect(screen.getByTestId('trailing')).toHaveTextContent('Trailing');
		expect(screen.getByTestId('inside')).toHaveTextContent('Inside');
	});

	it('calls onFocusBlock and onInputText when the block editor is focused and typed into', async () => {
		const ydoc = new Y.Doc();
		const doc = createDocument(ydoc, { title: 'D' });
		const block = createRecord(ydoc, { parentId: doc.id, blockType: 'paragraph' }, actor);
		const props = baseProps(ydoc, block);

		render(BlockRow, props);
		const editor = document.querySelector(`[data-block-editor-id="${block.id}"]`) as HTMLElement;
		editor.focus();
		expect(props.onFocusBlock).toHaveBeenCalled();

		editor.textContent = 'hi';
		await fireEvent.input(editor);
		expect(props.onInputText).toHaveBeenCalled();
	});
});
