import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { createDocument } from '$lib/data/document-ops';
import { createCollection, deleteCollection, listCollections } from '$lib/data/collection-ops';
import { createRecord, getRecord, setRecordViewConfig } from '$lib/data/record-ops';
import CollectionViewBlock from './CollectionViewBlock.svelte';

vi.mock('$app/state', () => ({
	get page() {
		return { params: { spaceId: 'space-1' } };
	}
}));

let ydoc: Y.Doc;
vi.mock('$lib/client/yjs-client', () => ({
	getClientDoc: () => ydoc,
	getShardDoc: () => ydoc
}));

const actor = { kind: 'human' as const, userId: 'local' };

describe('CollectionViewBlock', () => {
	beforeEach(() => {
		ydoc = new Y.Doc();
		// The nested Table/Board/Calendar views (once a block is configured)
		// each resolve their real shard via a fetch before connecting — see
		// #120. Stubbed to resolve immediately against the same test doc.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: true, json: async () => ({ shardId: 'test-shard' }) }))
		);
	});

	afterEach(() => {
		ydoc.destroy();
		vi.unstubAllGlobals();
	});

	it('shows a picker when the block has no target set yet', () => {
		const doc = createDocument(ydoc, { title: 'Team Page' });
		const block = createRecord(ydoc, { parentId: doc.id, blockType: 'collection_view' }, actor);

		render(CollectionViewBlock, {
			block: getRecord(ydoc, block.id)!,
			ydoc,
			collections: listCollections(ydoc)
		});

		expect(screen.getByText('Embed a collection view:')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Insert' })).toBeDisabled();
	});

	it('lists existing collections in the picker and inserts the chosen one', async () => {
		const doc = createDocument(ydoc, { title: 'Team Page' });
		createCollection(ydoc, { title: 'Sprint Tasks', schema: [] });
		const block = createRecord(ydoc, { parentId: doc.id, blockType: 'collection_view' }, actor);
		const user = userEvent.setup();

		render(CollectionViewBlock, {
			block: getRecord(ydoc, block.id)!,
			ydoc,
			collections: listCollections(ydoc)
		});

		const selects = screen.getAllByRole('combobox');
		await user.selectOptions(selects[0], 'board');
		await user.selectOptions(selects[1], 'Sprint Tasks');
		await user.click(screen.getByRole('button', { name: 'Insert' }));

		const stored = getRecord(ydoc, block.id);
		expect(stored?.referencedRecordId).toBeDefined();
		expect(stored?.viewConfig?.viewType).toBe('board');
	});

	it('renders the resolved collection as a Board when configured', () => {
		const doc = createDocument(ydoc, { title: 'Team Page' });
		const collection = createCollection(ydoc, {
			title: 'Sprint Tasks',
			schema: [{ key: 'status', label: 'Status', type: 'select', options: [] }]
		});
		const block = createRecord(
			ydoc,
			{
				parentId: doc.id,
				blockType: 'collection_view',
				referencedRecordId: collection.id,
				viewConfig: { viewType: 'board' }
			},
			actor
		);

		render(CollectionViewBlock, {
			block: getRecord(ydoc, block.id)!,
			ydoc,
			collections: listCollections(ydoc)
		});

		expect(screen.getByText('Sprint Tasks')).toBeInTheDocument();
		expect(screen.getByText('· board')).toBeInTheDocument();
	});

	it('shows a broken-embed state once the target collection is deleted, preserving the reference', () => {
		const doc = createDocument(ydoc, { title: 'Team Page' });
		const collection = createCollection(ydoc, { title: 'Doomed', schema: [] });
		const block = createRecord(
			ydoc,
			{
				parentId: doc.id,
				blockType: 'collection_view',
				referencedRecordId: collection.id,
				viewConfig: { viewType: 'table' }
			},
			actor
		);
		deleteCollection(ydoc, collection.id);

		render(CollectionViewBlock, {
			block: getRecord(ydoc, block.id)!,
			ydoc,
			collections: listCollections(ydoc)
		});

		expect(screen.getByText('Embedded collection was deleted')).toBeInTheDocument();
		expect(getRecord(ydoc, block.id)?.referencedRecordId).toBe(collection.id);
	});

	it('does not preselect the deleted target when changing a broken embed, and keeps Insert disabled until a live collection is chosen', async () => {
		const doc = createDocument(ydoc, { title: 'Team Page' });
		const collection = createCollection(ydoc, { title: 'Doomed', schema: [] });
		createCollection(ydoc, { title: 'Still Here', schema: [] });
		const block = createRecord(
			ydoc,
			{
				parentId: doc.id,
				blockType: 'collection_view',
				referencedRecordId: collection.id,
				viewConfig: { viewType: 'table' }
			},
			actor
		);
		deleteCollection(ydoc, collection.id);
		const user = userEvent.setup();

		render(CollectionViewBlock, {
			block: getRecord(ydoc, block.id)!,
			ydoc,
			collections: listCollections(ydoc)
		});
		await user.click(screen.getByRole('button', { name: 'Change' }));

		const selects = screen.getAllByRole('combobox');
		expect(selects[1]).toHaveValue('');
		expect(screen.getByRole('button', { name: 'Insert' })).toBeDisabled();
	});

	it('lets the user change an already-configured embed to a different collection/view', async () => {
		const doc = createDocument(ydoc, { title: 'Team Page' });
		const collectionA = createCollection(ydoc, { title: 'Collection A', schema: [] });
		createCollection(ydoc, { title: 'Collection B', schema: [] });
		const block = createRecord(
			ydoc,
			{
				parentId: doc.id,
				blockType: 'collection_view',
				referencedRecordId: collectionA.id,
				viewConfig: { viewType: 'table' }
			},
			actor
		);
		const user = userEvent.setup();

		render(CollectionViewBlock, {
			block: getRecord(ydoc, block.id)!,
			ydoc,
			collections: listCollections(ydoc)
		});
		await user.click(screen.getByRole('button', { name: 'Change' }));

		const selects = screen.getAllByRole('combobox');
		await user.selectOptions(selects[1], 'Collection B');
		await user.click(screen.getByRole('button', { name: 'Insert' }));

		const collectionB = listCollections(ydoc).find((c) => c.title === 'Collection B')!;
		expect(getRecord(ydoc, block.id)?.referencedRecordId).toBe(collectionB.id);
	});

	it('renders the resolved collection as a Calendar when configured', async () => {
		const doc = createDocument(ydoc, { title: 'Team Page' });
		const collection = createCollection(ydoc, {
			title: 'Launch Dates',
			schema: [{ key: 'due', label: 'Due', type: 'date' }]
		});
		const block = createRecord(
			ydoc,
			{
				parentId: doc.id,
				blockType: 'collection_view',
				referencedRecordId: collection.id,
				viewConfig: { viewType: 'calendar', groupBy: 'due' }
			},
			actor
		);

		render(CollectionViewBlock, {
			block: getRecord(ydoc, block.id)!,
			ydoc,
			collections: listCollections(ydoc)
		});

		expect(screen.getByText('Launch Dates')).toBeInTheDocument();
		// CalendarCollectionView resolves its shard asynchronously (#120) before
		// rendering schema-driven content, so this needs to wait rather than
		// assert synchronously like the title above (rendered by
		// CollectionViewBlock itself, not the nested view).
		expect(await screen.findByText('Dates from')).toBeInTheDocument();
	});

	it('cancels out of the change picker back to the resolved view', async () => {
		const doc = createDocument(ydoc, { title: 'Team Page' });
		const collection = createCollection(ydoc, { title: 'Sprint Tasks', schema: [] });
		const block = createRecord(
			ydoc,
			{
				parentId: doc.id,
				blockType: 'collection_view',
				referencedRecordId: collection.id,
				viewConfig: { viewType: 'table' }
			},
			actor
		);
		const user = userEvent.setup();

		render(CollectionViewBlock, {
			block: getRecord(ydoc, block.id)!,
			ydoc,
			collections: listCollections(ydoc)
		});
		await user.click(screen.getByRole('button', { name: 'Change' }));
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.getByText('Sprint Tasks')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
	});

	// Issue #32: a viewer's filter/sort/grouping/visible-property edits must
	// stay local until an explicit Save — otherwise two collaborators viewing
	// the same embed would see each other's in-progress edits live.
	describe('draft view state', () => {
		function setUpTableEmbed() {
			const doc = createDocument(ydoc, { title: 'Team Page' });
			const collection = createCollection(ydoc, {
				title: 'Tasks',
				schema: [{ key: 'title', label: 'Title', type: 'text' }]
			});
			const block = createRecord(
				ydoc,
				{
					parentId: doc.id,
					blockType: 'collection_view',
					referencedRecordId: collection.id,
					viewConfig: { viewType: 'table' }
				},
				actor
			);
			return { block: getRecord(ydoc, block.id)!, collection };
		}

		it('does not persist a filter edit until Save view is clicked', async () => {
			const { block } = setUpTableEmbed();
			const user = userEvent.setup();
			render(CollectionViewBlock, { block, ydoc, collections: listCollections(ydoc) });

			await user.click(await screen.findByRole('button', { name: /Filter/ }));
			await user.click(screen.getByRole('button', { name: '+ Add filter' }));

			expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
			expect(getRecord(ydoc, block.id)?.viewConfig?.filters).toBeUndefined();

			await user.click(screen.getByRole('button', { name: 'Save view' }));

			expect(getRecord(ydoc, block.id)?.viewConfig?.filters).toHaveLength(1);
			expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
		});

		it('discards a local edit without ever touching the shared record', async () => {
			const { block } = setUpTableEmbed();
			const user = userEvent.setup();
			render(CollectionViewBlock, { block, ydoc, collections: listCollections(ydoc) });

			await user.click(await screen.findByRole('button', { name: /Filter/ }));
			await user.click(screen.getByRole('button', { name: '+ Add filter' }));
			expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

			await user.click(screen.getByRole('button', { name: 'Discard' }));

			expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
			expect(getRecord(ydoc, block.id)?.viewConfig?.filters).toBeUndefined();
		});

		it('picks up an external Save (no local edits) but never clobbers this viewer’s own unsaved draft', async () => {
			const { block } = setUpTableEmbed();
			const user = userEvent.setup();
			const { rerender } = render(CollectionViewBlock, {
				block,
				ydoc,
				collections: listCollections(ydoc)
			});
			await screen.findByRole('button', { name: /Filter/ });

			// Simulate a second collaborator saving a visible-properties change
			// on the same block from their own connection.
			setRecordViewConfig(
				ydoc,
				block.id,
				{ viewType: 'table', visibleProperties: ['title'] },
				actor
			);
			await rerender({
				block: getRecord(ydoc, block.id)!,
				ydoc,
				collections: listCollections(ydoc)
			});

			// No local edits of our own — the external save is reflected, not
			// flagged as unsaved.
			expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();

			// Now make our own local (unsaved) edit...
			await user.click(screen.getByRole('button', { name: /Filter/ }));
			await user.click(screen.getByRole('button', { name: '+ Add filter' }));
			expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

			// ...and have a third collaborator save something else concurrently.
			setRecordViewConfig(
				ydoc,
				block.id,
				{ viewType: 'table', visibleProperties: ['title'], groupBy: undefined, sort: undefined },
				actor
			);
			await rerender({
				block: getRecord(ydoc, block.id)!,
				ydoc,
				collections: listCollections(ydoc)
			});

			// Our own unsaved local filter edit must survive, not be silently
			// overwritten by the other collaborator's concurrent save.
			expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
			expect(screen.getByText(/Filter \(1\)/)).toBeInTheDocument();
		});

		it('resets the draft when retargeted to a different collection', async () => {
			const { block, collection } = setUpTableEmbed();
			createCollection(ydoc, { title: 'Other', schema: [] });
			const user = userEvent.setup();

			const { rerender } = render(CollectionViewBlock, {
				block,
				ydoc,
				collections: listCollections(ydoc)
			});
			await user.click(await screen.findByRole('button', { name: /Filter/ }));
			await user.click(screen.getByRole('button', { name: '+ Add filter' }));
			expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

			await user.click(screen.getByRole('button', { name: 'Change' }));
			const selects = screen.getAllByRole('combobox');
			await user.selectOptions(selects[1], 'Other');
			await user.click(screen.getByRole('button', { name: 'Insert' }));
			// Mirrors production: the parent re-passes a fresh `block` once its
			// own Yjs observer picks up insert()'s write.
			await rerender({
				block: getRecord(ydoc, block.id)!,
				ydoc,
				collections: listCollections(ydoc)
			});

			expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
			expect(getRecord(ydoc, block.id)?.referencedRecordId).not.toBe(collection.id);
		});
	});
});
