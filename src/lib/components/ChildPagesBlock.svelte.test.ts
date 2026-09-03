import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { createDocument, createRecord, getRecord, listDocuments } from '$lib/data/records';
import type { ActorId } from '$lib/data/types';
import ChildPagesBlock from './ChildPagesBlock.svelte';

vi.mock('$app/state', () => ({
	get page() {
		return { params: { spaceId: 'space-1' } };
	}
}));

const actor: ActorId = { kind: 'human', userId: 'local' };

describe('ChildPagesBlock (issue #43)', () => {
	it('shows a placeholder when the target Document has no sub-pages', () => {
		const ydoc = new Y.Doc();
		const root = createDocument(ydoc, { title: 'Root' });
		const block = createRecord(ydoc, { parentId: root.id, blockType: 'child_pages' }, actor);

		render(ChildPagesBlock, {
			block: getRecord(ydoc, block.id)!,
			ydoc,
			documents: listDocuments(ydoc),
			currentDocumentId: root.id
		});

		expect(screen.getByText('No sub-pages yet.')).toBeInTheDocument();
	});

	it("lists the current Document's immediate children by default, without grandchildren", () => {
		const ydoc = new Y.Doc();
		const root = createDocument(ydoc, { title: 'Root' });
		const childA = createDocument(ydoc, { title: 'Child A', parentDocumentId: root.id });
		createDocument(ydoc, {
			title: 'Child B',
			parentDocumentId: root.id,
			afterDocumentId: childA.id
		});
		createDocument(ydoc, { title: 'Grandchild', parentDocumentId: childA.id });
		const block = createRecord(ydoc, { parentId: root.id, blockType: 'child_pages' }, actor);

		render(ChildPagesBlock, {
			block: getRecord(ydoc, block.id)!,
			ydoc,
			documents: listDocuments(ydoc),
			currentDocumentId: root.id
		});

		expect(screen.getByText('Child A')).toBeInTheDocument();
		expect(screen.getByText('Child B')).toBeInTheDocument();
		expect(screen.queryByText('Grandchild')).not.toBeInTheDocument();
	});

	it('changing the target page via the settings menu persists referencedRecordId', async () => {
		const ydoc = new Y.Doc();
		const root = createDocument(ydoc, { title: 'Root' });
		const other = createDocument(ydoc, { title: 'Other Page' });
		createDocument(ydoc, { title: 'Other Child', parentDocumentId: other.id });
		const block = createRecord(ydoc, { parentId: root.id, blockType: 'child_pages' }, actor);
		const user = userEvent.setup();

		render(ChildPagesBlock, {
			block: getRecord(ydoc, block.id)!,
			ydoc,
			documents: listDocuments(ydoc),
			currentDocumentId: root.id
		});

		await user.click(screen.getByRole('button', { name: 'Child pages settings' }));
		await user.selectOptions(screen.getByLabelText('Page'), other.id);

		expect(getRecord(ydoc, block.id)?.referencedRecordId).toBe(other.id);
	});

	it('changing the depth via the settings menu persists childPagesDepth and reveals deeper nesting', async () => {
		const ydoc = new Y.Doc();
		const root = createDocument(ydoc, { title: 'Root' });
		const child = createDocument(ydoc, { title: 'Child', parentDocumentId: root.id });
		createDocument(ydoc, { title: 'Grandchild', parentDocumentId: child.id });
		const block = createRecord(ydoc, { parentId: root.id, blockType: 'child_pages' }, actor);
		const user = userEvent.setup();

		render(ChildPagesBlock, {
			block: getRecord(ydoc, block.id)!,
			ydoc,
			documents: listDocuments(ydoc),
			currentDocumentId: root.id
		});

		expect(screen.queryByText('Grandchild')).not.toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'Child pages settings' }));
		await user.selectOptions(screen.getByLabelText('Depth'), '2');

		expect(getRecord(ydoc, block.id)?.childPagesDepth).toBe(2);
	});

	it('shows an unavailable message when the explicit target no longer resolves', () => {
		const ydoc = new Y.Doc();
		const root = createDocument(ydoc, { title: 'Root' });
		const block = createRecord(
			ydoc,
			{ parentId: root.id, blockType: 'child_pages', referencedRecordId: 'missing-doc' },
			actor
		);

		render(ChildPagesBlock, {
			block: getRecord(ydoc, block.id)!,
			ydoc,
			documents: listDocuments(ydoc),
			currentDocumentId: root.id
		});

		expect(
			screen.getByText('Target page is unavailable. Choose another page from the settings menu.')
		).toBeInTheDocument();
	});

	it('closes the settings menu on Escape even though focus stays on the trigger button', async () => {
		const ydoc = new Y.Doc();
		const root = createDocument(ydoc, { title: 'Root' });
		const block = createRecord(ydoc, { parentId: root.id, blockType: 'child_pages' }, actor);
		const user = userEvent.setup();

		render(ChildPagesBlock, {
			block: getRecord(ydoc, block.id)!,
			ydoc,
			documents: listDocuments(ydoc),
			currentDocumentId: root.id
		});

		await user.click(screen.getByRole('button', { name: 'Child pages settings' }));
		expect(screen.getByRole('menu', { name: 'Child pages settings' })).toBeInTheDocument();

		await user.keyboard('{Escape}');
		expect(screen.queryByRole('menu', { name: 'Child pages settings' })).not.toBeInTheDocument();
	});
});
