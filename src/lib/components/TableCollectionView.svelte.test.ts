import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { createCollection, createRecord, getRecord } from '$lib/data/records';
import TableCollectionViewHarness from './TableCollectionViewHarness.svelte';

let ydoc: Y.Doc;
vi.mock('$lib/client/yjs-client', () => ({ getClientDoc: () => ydoc }));

const actor = { kind: 'human' as const, userId: 'local' };

function renderTable(collectionId: string) {
	return render(TableCollectionViewHarness, { collectionId });
}

describe('TableCollectionView', () => {
	beforeEach(() => {
		ydoc = new Y.Doc();
	});

	afterEach(() => {
		ydoc.destroy();
	});

	it('links to the full table when the collection has no properties yet', () => {
		createCollection(ydoc, { id: 'col-1', title: 'T', schema: [] });
		renderTable('col-1');
		expect(screen.getByRole('link', { name: 'full table' })).toHaveAttribute(
			'href',
			'/table/col-1'
		);
	});

	it('shows an empty-state row when the collection has no rows', () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'T',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		renderTable('col-1');
		expect(screen.getByText('No rows in this collection.')).toBeInTheDocument();
	});

	it('renders and edits a text cell', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'T',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		const record = createRecord(
			ydoc,
			{ parentId: 'col-1', properties: { name: { type: 'text', value: 'Alice' } } },
			actor
		);
		const user = userEvent.setup();
		renderTable('col-1');

		const input = screen.getByDisplayValue('Alice');
		await user.clear(input);
		await user.type(input, 'Bob');
		await user.tab();

		expect(getRecord(ydoc, record.id)?.properties?.name).toEqual({ type: 'text', value: 'Bob' });
	});

	it('adds a new row via "Add row"', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'T',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		const user = userEvent.setup();
		renderTable('col-1');

		const table = screen.getByRole('table');
		expect(within(table).queryAllByRole('textbox')).toHaveLength(0);
		await user.click(screen.getByRole('button', { name: 'Add row' }));

		expect(screen.queryByText('No rows in this collection.')).not.toBeInTheDocument();
		expect(within(table).getAllByRole('textbox')).toHaveLength(1);
	});

	it('removes a row via its delete button', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'T',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		const record = createRecord(
			ydoc,
			{ parentId: 'col-1', properties: { name: { type: 'text', value: 'Bob' } } },
			actor
		);
		const user = userEvent.setup();
		renderTable('col-1');

		expect(screen.getByDisplayValue('Bob')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Delete row' }));

		expect(getRecord(ydoc, record.id)).toBeUndefined();
	});

	it('adds a select option through the in-page dialog and offers it as a value', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'T',
			schema: [{ key: 'status', label: 'Status', type: 'select', options: [] }]
		});
		createRecord(ydoc, { parentId: 'col-1', properties: {} }, actor);
		const user = userEvent.setup();
		renderTable('col-1');

		await user.click(screen.getByTitle('Add option'));
		await user.type(screen.getByLabelText('Option name'), 'Done');
		await user.click(
			within(screen.getByRole('dialog')).getByRole('button', { name: 'Add option' })
		);

		const select = within(screen.getByRole('table')).getByRole('combobox');
		expect(within(select).getByText('Done')).toBeInTheDocument();
	});
});
