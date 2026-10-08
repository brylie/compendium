import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createDocument } from '$lib/data/document-ops';
import { createRecord, getRecord, getRecordYText } from '$lib/data/record-ops';
import { plainText, yTextToRichText } from '$lib/data/richtext';
import type { BlockEditorHandle } from '$lib/components/BlockRow.svelte';
import { createBlockEditing, blockHoldsFreeformText } from './block-editing.svelte';

const HUMAN = { kind: 'human' as const, userId: 'u1' };

function createMockEditor(overrides: Partial<BlockEditorHandle> = {}): BlockEditorHandle {
	return {
		render: vi.fn(),
		applyFormat: vi.fn(),
		applyFormatAtRange: vi.fn(),
		getSelectionRange: vi.fn(() => null),
		getFormatState: vi.fn(() => ({})),
		focusEditor: vi.fn(),
		focusEditorAtLine: vi.fn(),
		...overrides
	};
}

describe('block-editing.svelte', () => {
	it('blockHoldsFreeformText recognizes text-holding block types', () => {
		expect(blockHoldsFreeformText('paragraph')).toBe(true);
		expect(blockHoldsFreeformText('heading_1')).toBe(true);
		expect(blockHoldsFreeformText('divider')).toBe(false);
		expect(blockHoldsFreeformText()).toBe(false);
	});

	it('addBlockAfter creates a block and focuses it', async () => {
		const ydoc = new Y.Doc();
		createDocument(ydoc, { id: 'doc-1', title: 'Doc' });

		const focused: string[] = [];
		const mockEditor = createMockEditor({
			focusEditor: vi.fn(() => focused.push('focused'))
		});

		const editing = createBlockEditing({
			getYdoc: () => ydoc,
			getDefaultParentId: () => 'doc-1',
			getBlocks: () => [],
			getBlockEditor: () => mockEditor
		});

		const record = await editing.addBlockAfter(undefined, 'paragraph');
		expect(record).toBeDefined();
		expect(record?.blockType).toBe('paragraph');
		expect(getRecord(ydoc, record!.id)).toBeDefined();
		expect(mockEditor.focusEditor).toHaveBeenCalledWith(true);
	});

	it('handleEnter splits text at caret offset', async () => {
		const ydoc = new Y.Doc();
		createDocument(ydoc, { id: 'doc-1', title: 'Doc' });
		const b1 = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		getRecordYText(ydoc, b1.id)!.insert(0, 'Hello world');

		const mockEditor = createMockEditor();

		const editing = createBlockEditing({
			getYdoc: () => ydoc,
			getDefaultParentId: () => 'doc-1',
			getBlocks: () => [getRecord(ydoc, b1.id)!],
			getBlockEditor: () => mockEditor
		});

		await editing.handleEnter(b1, 5);

		const updatedB1 = getRecordYText(ydoc, b1.id)!;
		expect(plainText(yTextToRichText(updatedB1))).toBe('Hello');
	});

	it('handleBackspace joins current block into previous block', async () => {
		const ydoc = new Y.Doc();
		createDocument(ydoc, { id: 'doc-1', title: 'Doc' });
		const b1 = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		getRecordYText(ydoc, b1.id)!.insert(0, 'Part 1 ');
		const b2 = createRecord(
			ydoc,
			{ parentId: 'doc-1', blockType: 'paragraph', afterRecordId: b1.id },
			HUMAN
		);
		getRecordYText(ydoc, b2.id)!.insert(0, 'Part 2');

		const mockEditor = createMockEditor();

		const editing = createBlockEditing({
			getYdoc: () => ydoc,
			getDefaultParentId: () => 'doc-1',
			getBlocks: () => [getRecord(ydoc, b1.id)!, getRecord(ydoc, b2.id)!],
			getBlockEditor: () => mockEditor
		});

		await editing.handleBackspace(getRecord(ydoc, b2.id)!, 1);

		expect(getRecord(ydoc, b2.id)).toBeUndefined();
		const updatedB1 = getRecordYText(ydoc, b1.id)!;
		expect(plainText(yTextToRichText(updatedB1))).toBe('Part 1 Part 2');
		expect(mockEditor.focusEditor).toHaveBeenCalledWith(7);
	});

	it('handleArrowUpAtStart and handleArrowDownAtEnd navigate between editors', () => {
		const ydoc = new Y.Doc();
		createDocument(ydoc, { id: 'doc-1', title: 'Doc' });
		const b1 = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		const b2 = createRecord(
			ydoc,
			{ parentId: 'doc-1', blockType: 'paragraph', afterRecordId: b1.id },
			HUMAN
		);

		const editor1 = createMockEditor();
		const editor2 = createMockEditor();

		const editing = createBlockEditing({
			getYdoc: () => ydoc,
			getDefaultParentId: () => 'doc-1',
			getBlocks: () => [b1, b2],
			getBlockEditor: (id) => (id === b1.id ? editor1 : editor2)
		});

		const navigatedUp = editing.handleArrowUpAtStart(1, 10);
		expect(navigatedUp).toBe(true);
		expect(editor1.focusEditorAtLine).toHaveBeenCalledWith('last', 10);

		const navigatedDown = editing.handleArrowDownAtEnd(0, 20);
		expect(navigatedDown).toBe(true);
		expect(editor2.focusEditorAtLine).toHaveBeenCalledWith('first', 20);
	});
});
