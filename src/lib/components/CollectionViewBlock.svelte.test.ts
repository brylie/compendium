import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import {
	createCollection,
	createDocument,
	createRecord,
	deleteCollection,
	getRecord,
	listCollections
} from '$lib/data/records';
import CollectionViewBlock from './CollectionViewBlock.svelte';

let ydoc: Y.Doc;
vi.mock('$lib/client/yjs-client', () => ({ getClientDoc: () => ydoc }));

const actor = { kind: 'human' as const, userId: 'local' };

describe('CollectionViewBlock', () => {
	beforeEach(() => {
		ydoc = new Y.Doc();
	});

	afterEach(() => {
		ydoc.destroy();
	});

	it('shows a picker when the block has no target set yet', () => {
		const doc = createDocument(ydoc, { title: 'Team Page' });
		const block = createRecord(ydoc, { parentId: doc.id, blockType: 'collection_view' }, actor);

		render(CollectionViewBlock, { block: getRecord(ydoc, block.id)!, ydoc });

		expect(screen.getByText('Embed a collection view:')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Insert' })).toBeDisabled();
	});

	it('lists existing collections in the picker and inserts the chosen one', async () => {
		const doc = createDocument(ydoc, { title: 'Team Page' });
		createCollection(ydoc, { title: 'Sprint Tasks', schema: [] });
		const block = createRecord(ydoc, { parentId: doc.id, blockType: 'collection_view' }, actor);
		const user = userEvent.setup();

		render(CollectionViewBlock, { block: getRecord(ydoc, block.id)!, ydoc });

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

		render(CollectionViewBlock, { block: getRecord(ydoc, block.id)!, ydoc });

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

		render(CollectionViewBlock, { block: getRecord(ydoc, block.id)!, ydoc });

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

		render(CollectionViewBlock, { block: getRecord(ydoc, block.id)!, ydoc });
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

		render(CollectionViewBlock, { block: getRecord(ydoc, block.id)!, ydoc });
		await user.click(screen.getByRole('button', { name: 'Change' }));

		const selects = screen.getAllByRole('combobox');
		await user.selectOptions(selects[1], 'Collection B');
		await user.click(screen.getByRole('button', { name: 'Insert' }));

		const collectionB = listCollections(ydoc).find((c) => c.title === 'Collection B')!;
		expect(getRecord(ydoc, block.id)?.referencedRecordId).toBe(collectionB.id);
	});

	it('renders the resolved collection as a Calendar when configured', () => {
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

		render(CollectionViewBlock, { block: getRecord(ydoc, block.id)!, ydoc });

		expect(screen.getByText('Launch Dates')).toBeInTheDocument();
		expect(screen.getByText('Dates from')).toBeInTheDocument();
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

		render(CollectionViewBlock, { block: getRecord(ydoc, block.id)!, ydoc });
		await user.click(screen.getByRole('button', { name: 'Change' }));
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.getByText('Sprint Tasks')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
	});
});
