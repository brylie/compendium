import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { createCollection, getCollection, setPrimaryField } from '$lib/data/collection-ops';
import { createRecord, getRecord } from '$lib/data/record-ops';
import type { CollectionMeta } from '$lib/data/types';
import TableCollectionViewHarness from './TableCollectionViewHarness.svelte';

vi.mock('$app/state', () => ({
	get page() {
		return { params: { spaceId: 'space-1' } };
	}
}));

let ydoc: Y.Doc;
const resolveCollectionDocMock = vi.fn<(collectionId: string) => Promise<Y.Doc>>(() =>
	Promise.resolve(ydoc)
);
vi.mock('$lib/client/yjs-client', () => ({
	getClientDoc: () => ydoc,
	getShardDoc: () => ydoc,
	resolveCollectionDoc: (id: string) => resolveCollectionDocMock(id)
}));

const actor = { kind: 'human' as const, userId: 'local' };

function renderTable(
	collectionId: string,
	initialConfig: import('$lib/data/views').ViewConfig = {},
	onConfigChange?: (config: import('$lib/data/views').ViewConfig) => void,
	collections: CollectionMeta[] = []
) {
	return render(TableCollectionViewHarness, {
		collectionId,
		initialConfig,
		onConfigChange,
		collections
	});
}

describe('TableCollectionView', () => {
	beforeEach(() => {
		ydoc = new Y.Doc();
		resolveCollectionDocMock.mockReset().mockImplementation(() => Promise.resolve(ydoc));
		// TableCollectionView resolves its real shard via a fetch before
		// connecting — see #120. Stubbed to resolve immediately against the
		// same test doc.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: true, json: async () => ({ shardId: 'test-shard' }) }))
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

	describe('record detail pane (issue #154)', () => {
		it('opens a record, shows every schema property, and edits sync to the underlying row', async () => {
			createCollection(ydoc, {
				id: 'col-1',
				title: 'Tasks',
				schema: [
					{ key: 'name', label: 'Name', type: 'text' },
					{ key: 'notes', label: 'Notes', type: 'text' }
				]
			});
			const record = createRecord(
				ydoc,
				{
					parentId: 'col-1',
					properties: {
						name: { type: 'text', value: 'Ship it' },
						notes: { type: 'text', value: 'Almost done' }
					}
				},
				actor
			);
			const user = userEvent.setup();
			renderTable('col-1');

			await user.click(await screen.findByRole('button', { name: 'Open record' }));

			const pane = screen.getByRole('region', { name: 'Record details' });
			expect(within(pane).getByText('Tasks')).toBeInTheDocument();
			const notesInput = within(pane).getByDisplayValue('Almost done');
			await user.clear(notesInput);
			await user.type(notesInput, 'Shipped');
			await user.tab();

			expect(getRecord(ydoc, record.id)?.properties?.notes).toEqual({
				type: 'text',
				value: 'Shipped'
			});
			// The originating grid's own cell picks up the same edit live, off
			// the same Yjs record — no second write path.
			expect(screen.getAllByDisplayValue('Shipped')).toHaveLength(2);
		});

		it('shows createdBy/lastEditedBy attribution', async () => {
			createCollection(ydoc, {
				id: 'col-1',
				title: 'Tasks',
				schema: [{ key: 'name', label: 'Name', type: 'text' }]
			});
			createRecord(
				ydoc,
				{ parentId: 'col-1', properties: { name: { type: 'text', value: 'Ship it' } } },
				actor
			);
			const user = userEvent.setup();
			renderTable('col-1');

			await user.click(await screen.findByRole('button', { name: 'Open record' }));

			const pane = screen.getByRole('region', { name: 'Record details' });
			expect(within(pane).getByText(/^Created by You/)).toBeInTheDocument();
			expect(within(pane).getByText(/^Last edited by You/)).toBeInTheDocument();
		});

		it('closes via its close button', async () => {
			createCollection(ydoc, {
				id: 'col-1',
				title: 'Tasks',
				schema: [{ key: 'name', label: 'Name', type: 'text' }]
			});
			createRecord(ydoc, { parentId: 'col-1', properties: {} }, actor);
			const user = userEvent.setup();
			renderTable('col-1');

			await user.click(await screen.findByRole('button', { name: 'Open record' }));
			expect(screen.getByRole('region', { name: 'Record details' })).toBeInTheDocument();

			await user.click(screen.getByRole('button', { name: 'Close record details' }));
			expect(screen.queryByRole('region', { name: 'Record details' })).not.toBeInTheDocument();
		});

		it('closes on Escape', async () => {
			createCollection(ydoc, {
				id: 'col-1',
				title: 'Tasks',
				schema: [{ key: 'name', label: 'Name', type: 'text' }]
			});
			createRecord(ydoc, { parentId: 'col-1', properties: {} }, actor);
			const user = userEvent.setup();
			renderTable('col-1');

			await user.click(await screen.findByRole('button', { name: 'Open record' }));
			expect(screen.getByRole('region', { name: 'Record details' })).toBeInTheDocument();

			await user.keyboard('{Escape}');
			expect(screen.queryByRole('region', { name: 'Record details' })).not.toBeInTheDocument();
		});

		it('shows same-collection relation backlinks under "Referenced by"', async () => {
			createCollection(ydoc, {
				id: 'col-1',
				title: 'Tasks',
				schema: [
					{ key: 'name', label: 'Name', type: 'text' },
					{
						key: 'blockedBy',
						label: 'Blocked by',
						type: 'relation',
						targetCollectionId: 'col-1'
					}
				]
			});
			const target = createRecord(
				ydoc,
				{ parentId: 'col-1', properties: { name: { type: 'text', value: 'Design' } } },
				actor
			);
			createRecord(
				ydoc,
				{
					parentId: 'col-1',
					properties: {
						name: { type: 'text', value: 'Build' },
						blockedBy: { type: 'relation', value: [target.id] }
					}
				},
				actor
			);
			const user = userEvent.setup();
			renderTable('col-1');

			const openButtons = await screen.findAllByRole('button', { name: 'Open record' });
			// "Design" is the first row created, and rows render in creation
			// order — open its own pane to see who references it.
			await user.click(openButtons[0]);

			const pane = screen.getByRole('region', { name: 'Record details' });
			expect(within(pane).getByText('Referenced by')).toBeInTheDocument();
			// Scoped to the backlinks list specifically — "Blocked by" also
			// appears as this record's own (empty) property label in its
			// property list above, which "Referenced by" must not be confused
			// with.
			const backlinksList = within(pane).getByRole('list');
			expect(within(backlinksList).getByText('Build')).toBeInTheDocument();
			expect(within(backlinksList).getByText('Blocked by')).toBeInTheDocument();
		});

		it('resolves and shows a backlink from a different Collection whose schema targets this one', async () => {
			createCollection(ydoc, {
				id: 'col-1',
				title: 'Projects',
				schema: [{ key: 'name', label: 'Name', type: 'text' }]
			});
			createCollection(ydoc, {
				id: 'col-2',
				title: 'Tasks',
				schema: [
					{ key: 'title', label: 'Title', type: 'text' },
					{
						key: 'project',
						label: 'Project',
						type: 'relation',
						targetCollectionId: 'col-1'
					}
				]
			});
			const project = createRecord(
				ydoc,
				{ parentId: 'col-1', properties: { name: { type: 'text', value: 'Website' } } },
				actor
			);
			createRecord(
				ydoc,
				{
					parentId: 'col-2',
					properties: {
						title: { type: 'text', value: 'Design homepage' },
						project: { type: 'relation', value: [project.id] }
					}
				},
				actor
			);
			const user = userEvent.setup();
			renderTable('col-1', {}, undefined, [
				getCollection(ydoc, 'col-1')!,
				getCollection(ydoc, 'col-2')!
			]);

			await user.click(await screen.findByRole('button', { name: 'Open record' }));

			const pane = screen.getByRole('region', { name: 'Record details' });
			expect(await within(pane).findByText('Referenced by')).toBeInTheDocument();
			const backlinksList = within(pane).getByRole('list');
			expect(await within(backlinksList).findByText('Design homepage')).toBeInTheDocument();
			expect(within(backlinksList).getByText('Tasks · Project')).toBeInTheDocument();
		});

		it('shows a load error for a candidate Collection whose shard fails to resolve', async () => {
			createCollection(ydoc, {
				id: 'col-1',
				title: 'Projects',
				schema: [{ key: 'name', label: 'Name', type: 'text' }]
			});
			createCollection(ydoc, {
				id: 'col-2',
				title: 'Tasks',
				schema: [
					{
						key: 'project',
						label: 'Project',
						type: 'relation',
						targetCollectionId: 'col-1'
					}
				]
			});
			createRecord(
				ydoc,
				{ parentId: 'col-1', properties: { name: { type: 'text', value: 'Website' } } },
				actor
			);
			resolveCollectionDocMock.mockImplementation((id: string) =>
				id === 'col-2' ? Promise.reject(new Error('shard unavailable')) : Promise.resolve(ydoc)
			);
			const user = userEvent.setup();
			renderTable('col-1', {}, undefined, [
				getCollection(ydoc, 'col-1')!,
				getCollection(ydoc, 'col-2')!
			]);

			await user.click(await screen.findByRole('button', { name: 'Open record' }));

			const pane = screen.getByRole('region', { name: 'Record details' });
			expect(await within(pane).findByText("Couldn't load Tasks")).toBeInTheDocument();
		});

		it('deletes the record from its own "Delete record" button', async () => {
			createCollection(ydoc, {
				id: 'col-1',
				title: 'Tasks',
				schema: [{ key: 'name', label: 'Name', type: 'text' }]
			});
			const record = createRecord(
				ydoc,
				{ parentId: 'col-1', properties: { name: { type: 'text', value: 'Ship it' } } },
				actor
			);
			const user = userEvent.setup();
			renderTable('col-1');

			await user.click(await screen.findByRole('button', { name: 'Open record' }));
			await user.click(screen.getByRole('button', { name: 'Delete record' }));

			expect(getRecord(ydoc, record.id)).toBeUndefined();
			expect(screen.queryByRole('region', { name: 'Record details' })).not.toBeInTheDocument();
		});

		it('shows a deleted-record state instead of closing when the open record is removed elsewhere', async () => {
			createCollection(ydoc, {
				id: 'col-1',
				title: 'Tasks',
				schema: [{ key: 'name', label: 'Name', type: 'text' }]
			});
			const record = createRecord(
				ydoc,
				{ parentId: 'col-1', properties: { name: { type: 'text', value: 'Ship it' } } },
				actor
			);
			const user = userEvent.setup();
			renderTable('col-1');

			await user.click(await screen.findByRole('button', { name: 'Open record' }));
			await user.click(screen.getByRole('button', { name: 'Delete row' }));

			const pane = screen.getByRole('region', { name: 'Record details' });
			expect(within(pane).getByText('This record was deleted.')).toBeInTheDocument();
			expect(getRecord(ydoc, record.id)).toBeUndefined();
		});

		it('adds a select option through the pane\'s own "+ add option" dialog', async () => {
			createCollection(ydoc, {
				id: 'col-1',
				title: 'Tasks',
				schema: [
					{ key: 'name', label: 'Name', type: 'text' },
					{ key: 'status', label: 'Status', type: 'select', options: [] }
				]
			});
			createRecord(ydoc, { parentId: 'col-1', properties: {} }, actor);
			const user = userEvent.setup();
			renderTable('col-1');

			await user.click(await screen.findByRole('button', { name: 'Open record' }));
			const pane = screen.getByRole('region', { name: 'Record details' });

			await user.click(within(pane).getByTitle('Add option'));
			await user.type(screen.getByLabelText('Option name'), 'Done');
			await user.click(
				within(screen.getByRole('dialog')).getByRole('button', { name: 'Add option' })
			);

			expect(within(pane).getByText('Done')).toBeInTheDocument();
		});

		it("dismisses the pane's select-option dialog via Cancel with no option added", async () => {
			createCollection(ydoc, {
				id: 'col-1',
				title: 'Tasks',
				schema: [
					{ key: 'name', label: 'Name', type: 'text' },
					{ key: 'status', label: 'Status', type: 'select', options: [] }
				]
			});
			createRecord(ydoc, { parentId: 'col-1', properties: {} }, actor);
			const user = userEvent.setup();
			renderTable('col-1');

			await user.click(await screen.findByRole('button', { name: 'Open record' }));
			const pane = screen.getByRole('region', { name: 'Record details' });

			await user.click(within(pane).getByTitle('Add option'));
			await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

			expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
			expect(getCollection(ydoc, 'col-1')?.schema.find((p) => p.key === 'status')?.options).toEqual(
				[]
			);
		});
	});
});
