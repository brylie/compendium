import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { createDocument } from '$lib/data/document-ops';
import { createRecord, getRecordYText } from '$lib/data/record-ops';
import type { ActorId } from '$lib/data/types';
import DocumentOutline from './DocumentOutline.svelte';

const human: ActorId = { kind: 'human', userId: 'local' };

describe('DocumentOutline: List View (#152)', () => {
	it('renders nothing when closed', () => {
		const ydoc = new Y.Doc();
		render(DocumentOutline, {
			open: false,
			flatBlocks: [],
			ydoc,
			activeBlockId: null,
			onSelect: vi.fn(),
			onClose: vi.fn()
		});

		expect(screen.queryByRole('region', { name: 'Document outline' })).not.toBeInTheDocument();
	});

	it('lists every block in order, nesting non-heading blocks under the nearest heading', () => {
		const ydoc = new Y.Doc();
		const document = createDocument(ydoc, { title: 'D' });
		const heading = createRecord(ydoc, { parentId: document.id, blockType: 'heading_1' }, human);
		getRecordYText(ydoc, heading.id)!.insert(0, 'Introduction');
		const paragraph = createRecord(ydoc, { parentId: document.id, blockType: 'paragraph' }, human);
		getRecordYText(ydoc, paragraph.id)!.insert(0, 'Some body text');
		const divider = createRecord(ydoc, { parentId: document.id, blockType: 'divider' }, human);

		render(DocumentOutline, {
			open: true,
			flatBlocks: [
				{ record: heading, depth: 0 },
				{ record: paragraph, depth: 0 },
				{ record: divider, depth: 0 }
			],
			ydoc,
			activeBlockId: null,
			onSelect: vi.fn(),
			onClose: vi.fn()
		});

		const headingRow = screen.getByRole('button', { name: 'Introduction' });
		const bodyRow = screen.getByRole('button', { name: 'Some body text' });
		const dividerRow = screen.getByRole('button', { name: 'Divider' });

		// Both the paragraph and the divider nest one level deeper than the
		// heading that precedes them (heading hierarchy, not just document order).
		const headingIndent = parseInt(headingRow.style.paddingLeft, 10);
		const bodyIndent = parseInt(bodyRow.style.paddingLeft, 10);
		const dividerIndent = parseInt(dividerRow.style.paddingLeft, 10);
		expect(bodyIndent).toBeGreaterThan(headingIndent);
		expect(dividerIndent).toBe(bodyIndent);
	});

	it('closes a deeper heading level when a shallower or equal one follows', () => {
		const ydoc = new Y.Doc();
		const document = createDocument(ydoc, { title: 'D' });
		const h1 = createRecord(ydoc, { parentId: document.id, blockType: 'heading_1' }, human);
		getRecordYText(ydoc, h1.id)!.insert(0, 'Chapter');
		const h2 = createRecord(ydoc, { parentId: document.id, blockType: 'heading_2' }, human);
		getRecordYText(ydoc, h2.id)!.insert(0, 'Section');
		// A second heading_1 must close the still-open heading_2 above it
		// (pop back to depth 0) rather than nesting under it.
		const h1Again = createRecord(ydoc, { parentId: document.id, blockType: 'heading_1' }, human);
		getRecordYText(ydoc, h1Again.id)!.insert(0, 'Next chapter');

		render(DocumentOutline, {
			open: true,
			flatBlocks: [
				{ record: h1, depth: 0 },
				{ record: h2, depth: 0 },
				{ record: h1Again, depth: 0 }
			],
			ydoc,
			activeBlockId: null,
			onSelect: vi.fn(),
			onClose: vi.fn()
		});

		const firstChapter = screen.getByRole('button', { name: 'Chapter' });
		const nextChapter = screen.getByRole('button', { name: 'Next chapter' });
		expect(parseInt(nextChapter.style.paddingLeft, 10)).toBe(
			parseInt(firstChapter.style.paddingLeft, 10)
		);
	});

	it('labels an empty text-bearing block distinctly rather than rendering a blank row', () => {
		const ydoc = new Y.Doc();
		const document = createDocument(ydoc, { title: 'D' });
		const paragraph = createRecord(ydoc, { parentId: document.id, blockType: 'paragraph' }, human);

		render(DocumentOutline, {
			open: true,
			flatBlocks: [{ record: paragraph, depth: 0 }],
			ydoc,
			activeBlockId: null,
			onSelect: vi.fn(),
			onClose: vi.fn()
		});

		expect(screen.getByRole('button', { name: 'Empty block' })).toBeInTheDocument();
	});

	it('calls onSelect with the clicked block id', async () => {
		const ydoc = new Y.Doc();
		const document = createDocument(ydoc, { title: 'D' });
		const heading = createRecord(ydoc, { parentId: document.id, blockType: 'heading_2' }, human);
		getRecordYText(ydoc, heading.id)!.insert(0, 'Section');
		const onSelect = vi.fn();
		const user = userEvent.setup();

		render(DocumentOutline, {
			open: true,
			flatBlocks: [{ record: heading, depth: 0 }],
			ydoc,
			activeBlockId: null,
			onSelect,
			onClose: vi.fn()
		});

		await user.click(screen.getByRole('button', { name: 'Section' }));
		expect(onSelect).toHaveBeenCalledWith(heading.id);
	});

	it('calls onClose from the close button', async () => {
		const ydoc = new Y.Doc();
		const onClose = vi.fn();
		const user = userEvent.setup();
		render(DocumentOutline, {
			open: true,
			flatBlocks: [],
			ydoc,
			activeBlockId: null,
			onSelect: vi.fn(),
			onClose
		});

		await user.click(screen.getByRole('button', { name: 'Close outline' }));
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('shows an empty-state message when the document has no blocks', () => {
		const ydoc = new Y.Doc();
		render(DocumentOutline, {
			open: true,
			flatBlocks: [],
			ydoc,
			activeBlockId: null,
			onSelect: vi.fn(),
			onClose: vi.fn()
		});

		expect(screen.getByText('No blocks yet.')).toBeInTheDocument();
	});
});
