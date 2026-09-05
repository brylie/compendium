import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { createCollection, deleteCollection, getCollection } from '$lib/data/collection-ops';
import FieldManagerDialog from './FieldManagerDialog.svelte';

let ydoc: Y.Doc;
vi.mock('$lib/client/yjs-client', () => ({ getShardDoc: () => ydoc }));

describe('FieldManagerDialog', () => {
	beforeEach(() => {
		ydoc = new Y.Doc();
	});

	afterEach(() => {
		ydoc.destroy();
	});

	it('lists the collection schema in order', () => {
		const collection = createCollection(ydoc, {
			title: 'T',
			schema: [
				{ key: 'a', label: 'Alpha', type: 'text' },
				{ key: 'b', label: 'Beta', type: 'number' }
			]
		});
		render(FieldManagerDialog, {
			open: true,
			collectionId: collection.id,
			shardId: 'test-shard',
			onClose: vi.fn()
		});

		const list = screen.getByRole('list');
		const items = within(list).getAllByRole('listitem');
		expect(items.map((li) => li.textContent)).toEqual([
			expect.stringContaining('Alpha'),
			expect.stringContaining('Beta')
		]);
	});

	it('renders nothing when closed', () => {
		const collection = createCollection(ydoc, { title: 'T', schema: [] });
		render(FieldManagerDialog, {
			open: false,
			collectionId: collection.id,
			shardId: 'test-shard',
			onClose: vi.fn()
		});
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});

	it('moves a field down, then back up', async () => {
		const collection = createCollection(ydoc, {
			title: 'T',
			schema: [
				{ key: 'a', label: 'Alpha', type: 'text' },
				{ key: 'b', label: 'Beta', type: 'text' }
			]
		});
		const user = userEvent.setup();
		render(FieldManagerDialog, {
			open: true,
			collectionId: collection.id,
			shardId: 'test-shard',
			onClose: vi.fn()
		});

		await user.click(screen.getByRole('button', { name: 'Move Alpha down' }));
		expect(getCollection(ydoc, collection.id)?.schema.map((p) => p.label)).toEqual([
			'Beta',
			'Alpha'
		]);

		await user.click(screen.getByRole('button', { name: 'Move Alpha up' }));
		expect(getCollection(ydoc, collection.id)?.schema.map((p) => p.label)).toEqual([
			'Alpha',
			'Beta'
		]);
	});

	it('disables moving the first field up and the last field down', () => {
		const collection = createCollection(ydoc, {
			title: 'T',
			schema: [
				{ key: 'a', label: 'Alpha', type: 'text' },
				{ key: 'b', label: 'Beta', type: 'text' }
			]
		});
		render(FieldManagerDialog, {
			open: true,
			collectionId: collection.id,
			shardId: 'test-shard',
			onClose: vi.fn()
		});

		expect(screen.getByRole('button', { name: 'Move Alpha up' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Move Beta down' })).toBeDisabled();
	});

	it('adds a new field via the bottom form', async () => {
		const collection = createCollection(ydoc, { title: 'T', schema: [] });
		const user = userEvent.setup();
		render(FieldManagerDialog, {
			open: true,
			collectionId: collection.id,
			shardId: 'test-shard',
			onClose: vi.fn()
		});

		expect(screen.getByRole('button', { name: 'Add field' })).toBeDisabled();

		await user.type(screen.getByPlaceholderText('Field name…'), 'Status');
		await user.selectOptions(screen.getByLabelText('Field type'), 'select');
		await user.click(screen.getByRole('button', { name: 'Add field' }));

		expect(getCollection(ydoc, collection.id)?.schema).toEqual([
			expect.objectContaining({ label: 'Status', type: 'select' })
		]);
	});

	it("adds a relation field with a target collection, and doesn't offer the picker for other types (issue #15)", async () => {
		const people = createCollection(ydoc, { title: 'People', schema: [] });
		const collection = createCollection(ydoc, { title: 'T', schema: [] });
		const user = userEvent.setup();
		render(FieldManagerDialog, {
			open: true,
			collectionId: collection.id,
			shardId: 'test-shard',
			collections: [
				{ id: people.id, title: 'People', schema: [], recordIds: [] },
				{ id: collection.id, title: 'T', schema: [], recordIds: [] }
			],
			onClose: vi.fn()
		});

		expect(screen.queryByLabelText('Target collection')).not.toBeInTheDocument();

		await user.type(screen.getByPlaceholderText('Field name…'), 'Assignee');
		await user.selectOptions(screen.getByLabelText('Field type'), 'relation');
		await user.selectOptions(screen.getByLabelText('Target collection'), people.id);
		await user.click(screen.getByRole('button', { name: 'Add field' }));

		expect(getCollection(ydoc, collection.id)?.schema).toEqual([
			expect.objectContaining({
				label: 'Assignee',
				type: 'relation',
				targetCollectionId: people.id
			})
		]);
	});

	it('closes on Escape', async () => {
		const collection = createCollection(ydoc, { title: 'T', schema: [] });
		const onClose = vi.fn();
		const user = userEvent.setup();
		render(FieldManagerDialog, {
			open: true,
			collectionId: collection.id,
			shardId: 'test-shard',
			onClose
		});

		await user.keyboard('{Escape}');

		expect(onClose).toHaveBeenCalledOnce();
	});

	it('a nested field-delete confirmation only cancels itself on Escape, not the whole manager', async () => {
		const collection = createCollection(ydoc, {
			title: 'T',
			schema: [{ key: 'a', label: 'Alpha', type: 'text' }]
		});
		const onClose = vi.fn();
		const user = userEvent.setup();
		render(FieldManagerDialog, {
			open: true,
			collectionId: collection.id,
			shardId: 'test-shard',
			onClose
		});

		await user.click(screen.getByRole('button', { name: 'Field options for Alpha' }));
		await user.click(screen.getByRole('menuitem', { name: 'Delete field' }));
		expect(screen.getByRole('dialog', { name: 'Delete field' })).toBeInTheDocument();

		await user.keyboard('{Escape}');

		expect(screen.queryByRole('dialog', { name: 'Delete field' })).not.toBeInTheDocument();
		expect(screen.getByRole('dialog', { name: 'Manage fields' })).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();
	});

	// These simulate another client deleting the Collection concurrently,
	// between the dialog opening and an action being confirmed — a real race
	// in this multi-writer CRDT app, not a contrived scenario (see FieldMenu's
	// equivalent tests for the same rationale).
	describe('when the collection is deleted out from under an open action (concurrent-actor race)', () => {
		it('surfaces an error instead of throwing when adding a field', async () => {
			const collection = createCollection(ydoc, { title: 'T', schema: [] });
			const user = userEvent.setup();
			render(FieldManagerDialog, {
				open: true,
				collectionId: collection.id,
				shardId: 'test-shard',
				onClose: vi.fn()
			});

			await user.type(screen.getByPlaceholderText('Field name…'), 'Status');
			deleteCollection(ydoc, collection.id);
			await user.click(screen.getByRole('button', { name: 'Add field' }));

			expect(screen.getByText('Could not add the field. Please try again.')).toBeInTheDocument();
		});
	});

	it('closes when clicking the backdrop outside the dialog', async () => {
		const collection = createCollection(ydoc, { title: 'T', schema: [] });
		const onClose = vi.fn();
		const user = userEvent.setup();
		render(FieldManagerDialog, {
			open: true,
			collectionId: collection.id,
			shardId: 'test-shard',
			onClose
		});

		await user.click(screen.getByRole('presentation'));

		expect(onClose).toHaveBeenCalledOnce();
	});

	it('does not close when clicking inside the dialog itself', async () => {
		const collection = createCollection(ydoc, { title: 'T', schema: [] });
		const onClose = vi.fn();
		const user = userEvent.setup();
		render(FieldManagerDialog, {
			open: true,
			collectionId: collection.id,
			shardId: 'test-shard',
			onClose
		});

		await user.click(screen.getByRole('dialog'));

		expect(onClose).not.toHaveBeenCalled();
	});

	// Regression: a nested FieldMenu's floating panel used to render behind
	// this dialog's own backdrop once the panel was portalled to
	// document.body — both became siblings there, so whichever had the
	// higher z-index won regardless of DOM nesting, and the panel's z-20
	// lost to the backdrop's z-40.
	it("a nested field menu's panel stacks above this dialog's own backdrop and escapes its scrollable list", async () => {
		const collection = createCollection(ydoc, {
			title: 'T',
			schema: [{ key: 'a', label: 'Alpha', type: 'text' }]
		});
		const user = userEvent.setup();
		render(FieldManagerDialog, {
			open: true,
			collectionId: collection.id,
			shardId: 'test-shard',
			onClose: vi.fn()
		});

		await user.click(screen.getByRole('button', { name: 'Field options for Alpha' }));

		const panel = screen.getByRole('menu');
		expect(panel).toHaveClass('z-50');
		expect(panel.parentElement).toBe(document.body);
	});
});
