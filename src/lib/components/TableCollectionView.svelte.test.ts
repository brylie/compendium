import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { createCollection, createRecord, getRecord, setPrimaryField } from '$lib/data/records';
import TableCollectionViewHarness from './TableCollectionViewHarness.svelte';

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

function renderTable(
	collectionId: string,
	initialConfig: import('$lib/data/views').ViewConfig = {},
	onConfigChange?: (config: import('$lib/data/views').ViewConfig) => void
) {
	return render(TableCollectionViewHarness, { collectionId, initialConfig, onConfigChange });
}

describe('TableCollectionView', () => {
	beforeEach(() => {
		ydoc = new Y.Doc();
		// TableCollectionView resolves its real shard via a fetch before
		// connecting — see #120. Stubbed to resolve immediately against the
		// same test doc.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ json: async () => ({ shardId: 'test-shard' }) }))
		);
	});

	afterEach(() => {
		ydoc.destroy();
		vi.unstubAllGlobals();
	});

	it('links to the full table when the collection has no properties yet', () => {
		createCollection(ydoc, { id: 'col-1', title: 'T', schema: [] });
		renderTable('col-1');
		expect(screen.getByRole('link', { name: 'full table' })).toHaveAttribute(
			'href',
			'/space/space-1/table/col-1'
		);
	});

	it('shows an empty-state row when the collection has no rows', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'T',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		renderTable('col-1');
		expect(await screen.findByText('No rows in this collection.')).toBeInTheDocument();
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

		const input = await screen.findByDisplayValue('Alice');
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

		const table = await screen.findByRole('table');
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

		expect(await screen.findByDisplayValue('Bob')).toBeInTheDocument();
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

		await user.click(await screen.findByTitle('Add option'));
		await user.type(screen.getByLabelText('Option name'), 'Done');
		await user.click(
			within(screen.getByRole('dialog')).getByRole('button', { name: 'Add option' })
		);

		// Scoped to <tbody> — the footer's per-column summary picker (a
		// combobox too) would otherwise make this ambiguous.
		const tbody = screen.getByRole('table').querySelector('tbody')!;
		const select = within(tbody).getByRole('combobox');
		expect(within(select).getByText('Done')).toBeInTheDocument();
	});

	it('marks the resolved primary field column with a visible indicator (issue #96)', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'T',
			schema: [
				{ key: 'name', label: 'Name', type: 'text' },
				{ key: 'notes', label: 'Notes', type: 'text' }
			]
		});
		renderTable('col-1');

		const nameHeader = await screen.findByRole('columnheader', { name: /^Name/ });
		const notesHeader = screen.getByRole('columnheader', { name: /^Notes/ });
		expect(within(nameHeader).getByText('Primary field')).toBeInTheDocument();
		expect(within(notesHeader).queryByText('Primary field')).not.toBeInTheDocument();
	});

	it('moves the primary-field indicator once an explicit primary field is chosen', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'T',
			schema: [
				{ key: 'name', label: 'Name', type: 'text' },
				{ key: 'notes', label: 'Notes', type: 'text' }
			]
		});
		setPrimaryField(ydoc, 'col-1', 'notes');
		renderTable('col-1');

		const nameHeader = await screen.findByRole('columnheader', { name: /^Name/ });
		const notesHeader = screen.getByRole('columnheader', { name: /^Notes/ });
		expect(within(nameHeader).queryByText('Primary field')).not.toBeInTheDocument();
		expect(within(notesHeader).getByText('Primary field')).toBeInTheDocument();
	});

	it('rejects a blank select option label with an inline error instead of silently doing nothing', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'T',
			schema: [{ key: 'status', label: 'Status', type: 'select', options: [] }]
		});
		createRecord(ydoc, { parentId: 'col-1', properties: {} }, actor);
		const user = userEvent.setup();
		renderTable('col-1');

		await user.click(await screen.findByTitle('Add option'));
		await user.click(
			within(screen.getByRole('dialog')).getByRole('button', { name: 'Add option' })
		);

		expect(
			within(screen.getByRole('dialog')).getByText('Option label cannot be blank')
		).toBeInTheDocument();
	});

	it('sorts rows by a Select field in configured option order, not by opaque option id (issue #95)', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'T',
			schema: [
				{ key: 'name', label: 'Name', type: 'text' },
				{
					key: 'status',
					label: 'Status',
					// Ids deliberately ordered backwards from the configured
					// workflow — a plain string compare would sort the wrong way.
					type: 'select',
					options: [
						{ id: 'zzz-backlog', label: 'Backlog' },
						{ id: 'mmm-in-progress', label: 'In progress' },
						{ id: 'aaa-done', label: 'Done' }
					]
				}
			]
		});
		createRecord(
			ydoc,
			{
				parentId: 'col-1',
				properties: {
					name: { type: 'text', value: 'Ship it' },
					status: { type: 'select', value: 'aaa-done' }
				}
			},
			actor
		);
		createRecord(
			ydoc,
			{
				parentId: 'col-1',
				properties: {
					name: { type: 'text', value: 'Draft it' },
					status: { type: 'select', value: 'zzz-backlog' }
				}
			},
			actor
		);
		createRecord(
			ydoc,
			{
				parentId: 'col-1',
				properties: {
					name: { type: 'text', value: 'Build it' },
					status: { type: 'select', value: 'mmm-in-progress' }
				}
			},
			actor
		);

		renderTable('col-1', { sort: { mode: 'property', propertyKey: 'status' } });

		const table = await screen.findByRole('table');
		// Scoped to <tbody> specifically — <thead>'s header row and <tfoot>'s
		// field-summary row are both role="row" too, and neither is a data row.
		const tbody = table.querySelector('tbody')!;
		const rows = within(tbody).getAllByRole('row');
		const names = rows.map((row) => (within(row).getByRole('textbox') as HTMLInputElement).value);
		expect(names).toEqual(['Draft it', 'Build it', 'Ship it']);
	});

	describe('field summaries (issue #32)', () => {
		it('defaults every column footer picker to "None" with no computed value shown', async () => {
			createCollection(ydoc, {
				id: 'col-1',
				title: 'T',
				schema: [{ key: 'qty', label: 'Qty', type: 'number' }]
			});
			createRecord(
				ydoc,
				{ parentId: 'col-1', properties: { qty: { type: 'number', value: 5 } } },
				actor
			);
			renderTable('col-1');

			const picker = await screen.findByLabelText('Qty summary');
			expect(picker).toHaveValue('none');
			const table = screen.getByRole('table');
			expect(within(table.querySelector('tfoot')!).queryByText('5')).not.toBeInTheDocument();
		});

		it('computes and shows a chosen summary, persisting the choice through onConfigChange', async () => {
			createCollection(ydoc, {
				id: 'col-1',
				title: 'T',
				schema: [{ key: 'qty', label: 'Qty', type: 'number' }]
			});
			createRecord(
				ydoc,
				{ parentId: 'col-1', properties: { qty: { type: 'number', value: 4 } } },
				actor
			);
			createRecord(
				ydoc,
				{ parentId: 'col-1', properties: { qty: { type: 'number', value: 6 } } },
				actor
			);
			const onConfigChange = vi.fn();
			renderTable('col-1', {}, onConfigChange);

			const picker = await screen.findByLabelText('Qty summary');
			const user = userEvent.setup();
			await user.selectOptions(picker, 'sum');

			expect(onConfigChange).toHaveBeenLastCalledWith(
				expect.objectContaining({ summaries: { qty: 'sum' } })
			);
			const table = screen.getByRole('table');
			expect(within(table.querySelector('tfoot')!).getByText('10')).toBeInTheDocument();
		});

		it('offers only type-appropriate summaries per column', async () => {
			createCollection(ydoc, {
				id: 'col-1',
				title: 'T',
				schema: [
					{ key: 'name', label: 'Name', type: 'text' },
					{ key: 'due', label: 'Due', type: 'date' }
				]
			});
			renderTable('col-1');

			const namePicker = await screen.findByLabelText('Name summary');
			const duePicker = screen.getByLabelText('Due summary');
			expect(within(namePicker).queryByText('Sum')).not.toBeInTheDocument();
			expect(within(duePicker).getByText('Earliest')).toBeInTheDocument();
			expect(within(namePicker).queryByText('Earliest')).not.toBeInTheDocument();
		});
	});
});
