import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { createCollection, createRecord, getCollection } from '$lib/data/records';
import Page from './+page.svelte';

let ydoc: Y.Doc;
vi.mock('$lib/client/yjs-client', () => ({ getClientDoc: () => ydoc }));

describe('table/[id] +page', () => {
	beforeEach(() => {
		ydoc = new Y.Doc();
	});

	afterEach(() => {
		ydoc.destroy();
	});

	it('shows the SSR title before the Y.Doc mounts, then the live title once it has', () => {
		createCollection(ydoc, { id: 'col-1', title: 'Live Title', schema: [] });
		render(Page, {
			params: { id: 'col-1' },
			form: null,
			data: { documents: [], collections: [], collectionId: 'col-1', title: 'SSR Title' }
		});
		expect(screen.getByPlaceholderText('Untitled Collection')).toHaveValue('Live Title');
	});

	it('shows an empty-state row when the collection has no rows', () => {
		createCollection(ydoc, { id: 'col-1', title: 'Empty', schema: [] });
		render(Page, {
			params: { id: 'col-1' },
			form: null,
			data: { documents: [], collections: [], collectionId: 'col-1', title: 'Empty' }
		});
		expect(screen.getByText('No rows in this collection.')).toBeInTheDocument();
	});

	it('renders a text cell bound to the row property value', () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'T',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		createRecord(
			ydoc,
			{ parentId: 'col-1', properties: { name: { type: 'text', value: 'Alice' } } },
			{ kind: 'human', userId: 'local' }
		);
		render(Page, {
			params: { id: 'col-1' },
			form: null,
			data: { documents: [], collections: [], collectionId: 'col-1', title: 'T' }
		});
		expect(screen.getByDisplayValue('Alice')).toBeInTheDocument();
	});

	it('adds a new property column via the schema editor form', async () => {
		createCollection(ydoc, { id: 'col-1', title: 'T', schema: [] });
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'col-1' },
			form: null,
			data: { documents: [], collections: [], collectionId: 'col-1', title: 'T' }
		});

		await user.type(screen.getByPlaceholderText('Property name…'), 'Status');
		await user.click(screen.getByRole('button', { name: 'Add property' }));

		expect(screen.getByText('Status')).toBeInTheDocument();
		expect(getCollection(ydoc, 'col-1')?.schema).toEqual([
			expect.objectContaining({ label: 'Status', type: 'text' })
		]);
	});

	it('adds a checkbox column and toggles it per row', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'T',
			schema: [{ key: 'done', label: 'Done', type: 'checkbox' }]
		});
		createRecord(ydoc, { parentId: 'col-1', properties: {} }, { kind: 'human', userId: 'local' });
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'col-1' },
			form: null,
			data: { documents: [], collections: [], collectionId: 'col-1', title: 'T' }
		});

		const checkbox = screen.getByRole('checkbox');
		await user.click(checkbox);

		const row = getCollection(ydoc, 'col-1');
		expect(row).toBeDefined();
		expect(checkbox).toBeChecked();
	});

	it('adds a new row when "Add row" is clicked', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'T',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'col-1' },
			form: null,
			data: { documents: [], collections: [], collectionId: 'col-1', title: 'T' }
		});

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
		createRecord(
			ydoc,
			{ parentId: 'col-1', properties: { name: { type: 'text', value: 'Bob' } } },
			{ kind: 'human', userId: 'local' }
		);
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'col-1' },
			form: null,
			data: { documents: [], collections: [], collectionId: 'col-1', title: 'T' }
		});

		expect(screen.getByDisplayValue('Bob')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Delete row' }));

		expect(screen.queryByDisplayValue('Bob')).not.toBeInTheDocument();
	});

	it('removes a property column via its header button', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'T',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'col-1' },
			form: null,
			data: { documents: [], collections: [], collectionId: 'col-1', title: 'T' }
		});

		await user.click(screen.getByRole('button', { name: 'Remove column' }));

		expect(screen.queryByText('Name')).not.toBeInTheDocument();
		expect(getCollection(ydoc, 'col-1')?.schema).toEqual([]);
	});

	it('adds a select option via a prompt and offers it as a select value', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'T',
			schema: [{ key: 'status', label: 'Status', type: 'select', options: [] }]
		});
		createRecord(ydoc, { parentId: 'col-1', properties: {} }, { kind: 'human', userId: 'local' });
		vi.spyOn(window, 'prompt').mockReturnValue('Done');
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'col-1' },
			form: null,
			data: { documents: [], collections: [], collectionId: 'col-1', title: 'T' }
		});

		await user.click(screen.getByTitle('Add option'));

		const select = within(screen.getByRole('table')).getByRole('combobox');
		expect(within(select).getByText('Done')).toBeInTheDocument();
	});

	it('does nothing when the new property label is blank', async () => {
		createCollection(ydoc, { id: 'col-1', title: 'T', schema: [] });
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'col-1' },
			form: null,
			data: { documents: [], collections: [], collectionId: 'col-1', title: 'T' }
		});

		await user.click(screen.getByRole('button', { name: 'Add property' }));

		expect(getCollection(ydoc, 'col-1')?.schema).toEqual([]);
	});

	it('edits number, date, select, and relation cell values', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'T',
			schema: [
				{ key: 'qty', label: 'Qty', type: 'number' },
				{ key: 'due', label: 'Due', type: 'date' },
				{
					key: 'status',
					label: 'Status',
					type: 'select',
					options: [{ id: 'opt-1', label: 'Open' }]
				},
				{ key: 'links', label: 'Links', type: 'relation' }
			]
		});
		const row = createRecord(
			ydoc,
			{
				parentId: 'col-1',
				properties: {
					qty: { type: 'number', value: 1 },
					due: { type: 'date', value: '2026-01-01' },
					status: { type: 'select', value: 'opt-1' },
					links: { type: 'relation', value: ['rec-a'] }
				}
			},
			{ kind: 'human', userId: 'local' }
		);
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'col-1' },
			form: null,
			data: { documents: [], collections: [], collectionId: 'col-1', title: 'T' }
		});

		const numberInput = screen.getByDisplayValue('1');
		await user.clear(numberInput);
		await user.type(numberInput, '7');
		await user.tab();

		const dateInput = screen.getByDisplayValue('2026-01-01');
		await user.clear(dateInput);
		await user.type(dateInput, '2026-02-02');
		await user.tab();

		const select = within(screen.getByRole('table')).getByRole('combobox');
		await user.selectOptions(select, 'opt-1');

		const relationInput = screen.getByDisplayValue('rec-a');
		await user.clear(relationInput);
		await user.type(relationInput, 'rec-b, rec-c');
		await user.tab();

		const stored = ydoc.getMap('records').get(row.id) as Y.Map<unknown>;
		expect(stored.get('prop:qty')).toMatchObject({ value: 7 });
		expect(stored.get('prop:due')).toMatchObject({ value: '2026-02-02' });
		expect(stored.get('prop:links')).toMatchObject({ value: ['rec-b', 'rec-c'] });
	});
});
