import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import {
	createCollection,
	createRecord,
	getCollection,
	updateCollectionTitle
} from '$lib/data/records';
import Page from './+page.svelte';

let ydoc: Y.Doc;
vi.mock('$lib/client/yjs-client', () => ({
	getClientDoc: () => ydoc,
	getShardDoc: () => ydoc,
	// A relation field's target Collection resolves through this instead of
	// getShardDoc directly (RelationPropertyCell, issue #15) — every fixture
	// in this file already lives in the one shared `ydoc`, so resolving any
	// targetCollectionId to that same doc keeps it consistent with
	// getShardDoc's own single-doc stand-in above.
	resolveCollectionDoc: () => Promise.resolve(ydoc)
}));

// +page.svelte resolves its real shard via a fetch before connecting — see
// #120. The table itself (unlike TableCollectionView) is unconditionally
// rendered rather than gated behind a schema check, so most of this file's
// assertions would otherwise race the async effect rather than fail cleanly.
// A macrotask flush after render reliably waits out that whole chain
// (2 microtask awaits + Svelte's own reactive flush, all settled before a
// setTimeout(0) fires) without needing a bespoke findBy per test.
async function flushShardResolution(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('table/[id] +page', () => {
	beforeEach(() => {
		ydoc = new Y.Doc();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: true, json: async () => ({ shardId: 'test-shard' }) }))
		);
	});

	afterEach(() => {
		ydoc.destroy();
		vi.unstubAllGlobals();
	});

	it('shows the SSR title before the Y.Doc mounts, then the live title once it has', async () => {
		createCollection(ydoc, { id: 'col-1', title: 'Live Title', schema: [] });
		render(Page, {
			params: { spaceId: 'space-1', id: 'col-1' },
			form: null,
			data: {
				spaces: [],
				spaceId: 'space-1',
				activeSpaceId: 'space-1',
				documents: [],
				collections: [],
				collectionId: 'col-1',
				title: 'SSR Title'
			}
		});
		await flushShardResolution();
		expect(screen.getByPlaceholderText('Untitled Collection')).toHaveValue('Live Title');
	});

	it('updates the displayed title when the collection is renamed from outside the component', async () => {
		createCollection(ydoc, { id: 'col-1', title: 'Original Title', schema: [] });
		render(Page, {
			params: { spaceId: 'space-1', id: 'col-1' },
			form: null,
			data: {
				spaces: [],
				spaceId: 'space-1',
				activeSpaceId: 'space-1',
				documents: [],
				collections: [],
				collectionId: 'col-1',
				title: 'Original Title'
			}
		});
		await flushShardResolution();
		expect(screen.getByPlaceholderText('Untitled Collection')).toHaveValue('Original Title');

		updateCollectionTitle(ydoc, 'col-1', 'Renamed From Another Client');

		expect(await screen.findByPlaceholderText('Untitled Collection')).toHaveValue(
			'Renamed From Another Client'
		);
		expect(
			await screen.findByText('Renamed From Another Client', { selector: 'span.font-medium' })
		).toBeInTheDocument();
	});

	it('re-derives title, schema, and rows when navigating client-side to a different collection id', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'First',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		createRecord(
			ydoc,
			{ parentId: 'col-1', properties: { name: { type: 'text', value: 'From collection one' } } },
			{ kind: 'human', userId: 'local' }
		);

		createCollection(ydoc, {
			id: 'col-2',
			title: 'Second',
			schema: [{ key: 'label', label: 'Label', type: 'text' }]
		});
		createRecord(
			ydoc,
			{
				parentId: 'col-2',
				properties: { label: { type: 'text', value: 'From collection two' } }
			},
			{ kind: 'human', userId: 'local' }
		);

		const { rerender } = render(Page, {
			params: { spaceId: 'space-1', id: 'col-1' },
			form: null,
			data: {
				spaces: [],
				spaceId: 'space-1',
				activeSpaceId: 'space-1',
				documents: [],
				collections: [],
				collectionId: 'col-1',
				title: 'First'
			}
		});
		await flushShardResolution();
		expect(screen.getByPlaceholderText('Untitled Collection')).toHaveValue('First');
		expect(screen.getByDisplayValue('From collection one')).toBeInTheDocument();

		await rerender({
			params: { spaceId: 'space-1', id: 'col-2' },
			form: null,
			data: {
				spaces: [],
				spaceId: 'space-1',
				activeSpaceId: 'space-1',
				documents: [],
				collections: [],
				collectionId: 'col-2',
				title: 'Second'
			}
		});
		await flushShardResolution();

		expect(screen.getByPlaceholderText('Untitled Collection')).toHaveValue('Second');
		expect(screen.queryByDisplayValue('From collection one')).not.toBeInTheDocument();
		expect(screen.getByDisplayValue('From collection two')).toBeInTheDocument();
	});

	it('shows an empty-state row when the collection has no rows', async () => {
		createCollection(ydoc, { id: 'col-1', title: 'Empty', schema: [] });
		render(Page, {
			params: { spaceId: 'space-1', id: 'col-1' },
			form: null,
			data: {
				spaces: [],
				spaceId: 'space-1',
				activeSpaceId: 'space-1',
				documents: [],
				collections: [],
				collectionId: 'col-1',
				title: 'Empty'
			}
		});
		await flushShardResolution();
		expect(screen.getByText('No rows in this collection.')).toBeInTheDocument();
	});

	it('renders a text cell bound to the row property value', async () => {
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
			params: { spaceId: 'space-1', id: 'col-1' },
			form: null,
			data: {
				spaces: [],
				spaceId: 'space-1',
				activeSpaceId: 'space-1',
				documents: [],
				collections: [],
				collectionId: 'col-1',
				title: 'T'
			}
		});
		await flushShardResolution();
		expect(screen.getByDisplayValue('Alice')).toBeInTheDocument();
	});

	it('adds a new field via the Manage fields dialog', async () => {
		createCollection(ydoc, { id: 'col-1', title: 'T', schema: [] });
		const user = userEvent.setup();
		render(Page, {
			params: { spaceId: 'space-1', id: 'col-1' },
			form: null,
			data: {
				spaces: [],
				spaceId: 'space-1',
				activeSpaceId: 'space-1',
				documents: [],
				collections: [],
				collectionId: 'col-1',
				title: 'T'
			}
		});
		await flushShardResolution();

		await user.click(screen.getByRole('button', { name: 'Manage fields' }));
		await user.type(screen.getByPlaceholderText('Field name…'), 'Status');
		await user.click(screen.getByRole('button', { name: 'Add field' }));

		expect(within(screen.getByRole('table')).getByText('Status')).toBeInTheDocument();
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
			params: { spaceId: 'space-1', id: 'col-1' },
			form: null,
			data: {
				spaces: [],
				spaceId: 'space-1',
				activeSpaceId: 'space-1',
				documents: [],
				collections: [],
				collectionId: 'col-1',
				title: 'T'
			}
		});
		await flushShardResolution();

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
			params: { spaceId: 'space-1', id: 'col-1' },
			form: null,
			data: {
				spaces: [],
				spaceId: 'space-1',
				activeSpaceId: 'space-1',
				documents: [],
				collections: [],
				collectionId: 'col-1',
				title: 'T'
			}
		});
		await flushShardResolution();

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
			params: { spaceId: 'space-1', id: 'col-1' },
			form: null,
			data: {
				spaces: [],
				spaceId: 'space-1',
				activeSpaceId: 'space-1',
				documents: [],
				collections: [],
				collectionId: 'col-1',
				title: 'T'
			}
		});
		await flushShardResolution();

		expect(screen.getByDisplayValue('Bob')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Delete row' }));

		expect(screen.queryByDisplayValue('Bob')).not.toBeInTheDocument();
	});

	it('removes a field via its header menu, after confirming', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'T',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		const user = userEvent.setup();
		render(Page, {
			params: { spaceId: 'space-1', id: 'col-1' },
			form: null,
			data: {
				spaces: [],
				spaceId: 'space-1',
				activeSpaceId: 'space-1',
				documents: [],
				collections: [],
				collectionId: 'col-1',
				title: 'T'
			}
		});
		await flushShardResolution();

		await user.click(screen.getByRole('button', { name: 'Field options for Name' }));
		await user.click(screen.getByRole('menuitem', { name: 'Delete field' }));
		await user.click(
			within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete field' })
		);

		expect(screen.queryByText('Name')).not.toBeInTheDocument();
		expect(getCollection(ydoc, 'col-1')?.schema).toEqual([]);
	});

	it('adds a select option through the in-page dialog and offers it as a select value', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'T',
			schema: [{ key: 'status', label: 'Status', type: 'select', options: [] }]
		});
		createRecord(ydoc, { parentId: 'col-1', properties: {} }, { kind: 'human', userId: 'local' });
		const user = userEvent.setup();
		render(Page, {
			params: { spaceId: 'space-1', id: 'col-1' },
			form: null,
			data: {
				spaces: [],
				spaceId: 'space-1',
				activeSpaceId: 'space-1',
				documents: [],
				collections: [],
				collectionId: 'col-1',
				title: 'T'
			}
		});
		await flushShardResolution();

		await user.click(screen.getByTitle('Add option'));
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

	it('disables "Add field" when the new field name is blank', async () => {
		createCollection(ydoc, { id: 'col-1', title: 'T', schema: [] });
		const user = userEvent.setup();
		render(Page, {
			params: { spaceId: 'space-1', id: 'col-1' },
			form: null,
			data: {
				spaces: [],
				spaceId: 'space-1',
				activeSpaceId: 'space-1',
				documents: [],
				collections: [],
				collectionId: 'col-1',
				title: 'T'
			}
		});
		await flushShardResolution();

		await user.click(screen.getByRole('button', { name: 'Manage fields' }));

		expect(screen.getByRole('button', { name: 'Add field' })).toBeDisabled();
		expect(getCollection(ydoc, 'col-1')?.schema).toEqual([]);
	});

	it('edits number, date, select, and relation cell values', async () => {
		const people = createCollection(ydoc, {
			title: 'People',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		const alice = createRecord(
			ydoc,
			{ parentId: people.id, properties: { name: { type: 'text', value: 'Alice' } } },
			{ kind: 'human', userId: 'local' }
		);
		const bob = createRecord(
			ydoc,
			{ parentId: people.id, properties: { name: { type: 'text', value: 'Bob' } } },
			{ kind: 'human', userId: 'local' }
		);
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
					options: [
						{ id: 'opt-1', label: 'Open' },
						{ id: 'opt-2', label: 'Done' }
					]
				},
				{ key: 'links', label: 'Links', type: 'relation', targetCollectionId: people.id }
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
					links: { type: 'relation', value: [alice.id] }
				}
			},
			{ kind: 'human', userId: 'local' }
		);
		const user = userEvent.setup();
		render(Page, {
			params: { spaceId: 'space-1', id: 'col-1' },
			form: null,
			data: {
				spaces: [],
				spaceId: 'space-1',
				activeSpaceId: 'space-1',
				documents: [],
				collections: [],
				collectionId: 'col-1',
				title: 'T'
			}
		});
		await flushShardResolution();

		const numberInput = screen.getByDisplayValue('1');
		await user.clear(numberInput);
		await user.type(numberInput, '7');
		await user.tab();

		const dateInput = screen.getByDisplayValue('2026-01-01');
		await user.clear(dateInput);
		await user.type(dateInput, '2026-02-02');
		await user.tab();

		// Scoped to <tbody> — the footer's per-column summary picker (a
		// combobox too) would otherwise make this ambiguous.
		const tbody = screen.getByRole('table').querySelector('tbody')!;
		const select = within(tbody).getByRole('combobox');
		await user.selectOptions(select, 'opt-2');

		// Relation: replace the resolved "Alice" chip with "Bob" via the
		// search picker (issue #15) — the old raw comma-separated-id input no
		// longer exists.
		await screen.findByText('Alice');
		await user.click(screen.getByRole('button', { name: 'Add Links' }));
		await user.type(screen.getByPlaceholderText(/Search/), 'Bob');
		await user.click(await screen.findByRole('button', { name: 'Bob' }));
		await user.click(screen.getByRole('button', { name: 'Remove Alice' }));

		const stored = ydoc.getMap('records').get(row.id) as Y.Map<unknown>;
		expect(stored.get('prop:qty')).toMatchObject({ value: 7 });
		expect(stored.get('prop:due')).toMatchObject({ value: '2026-02-02' });
		expect(stored.get('prop:status')).toMatchObject({ value: 'opt-2' });
		expect(stored.get('prop:links')).toMatchObject({ value: [bob.id] });
	});
});
