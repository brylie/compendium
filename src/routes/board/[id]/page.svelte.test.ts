import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { createCollection, createRecord, getRecord } from '$lib/data/records';
import Page from './+page.svelte';

let ydoc: Y.Doc;
vi.mock('$lib/client/yjs-client', () => ({ getClientDoc: () => ydoc }));

const actor = { kind: 'human' as const, userId: 'local' };

describe('board/[id] +page', () => {
	beforeEach(() => {
		ydoc = new Y.Doc();
	});

	afterEach(() => {
		ydoc.destroy();
	});

	it('prompts to add a select property when the collection has none', () => {
		createCollection(ydoc, { id: 'col-1', title: 'Board', schema: [] });
		render(Page, {
			params: { id: 'col-1' },
			form: null,
			data: { documents: [], collections: [], collectionId: 'col-1', title: 'Board' }
		});

		expect(screen.getByText(/doesn't have one yet/)).toBeInTheDocument();
	});

	it('adds a select property via the prompt and switches into the board', async () => {
		createCollection(ydoc, { id: 'col-1', title: 'Board', schema: [] });
		vi.spyOn(window, 'prompt').mockReturnValue('Status');
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'col-1' },
			form: null,
			data: { documents: [], collections: [], collectionId: 'col-1', title: 'Board' }
		});

		await user.click(screen.getByRole('button', { name: 'Add a select property' }));

		expect(screen.getByText('No Status')).toBeInTheDocument();
	});

	it('renders one column per select option, plus a catch-all, even when empty', () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'Board',
			schema: [
				{
					key: 'status',
					label: 'Status',
					type: 'select',
					options: [
						{ id: 'todo', label: 'To do' },
						{ id: 'done', label: 'Done' }
					]
				}
			]
		});
		render(Page, {
			params: { id: 'col-1' },
			form: null,
			data: { documents: [], collections: [], collectionId: 'col-1', title: 'Board' }
		});

		expect(screen.getByText('To do')).toBeInTheDocument();
		expect(screen.getByText('Done')).toBeInTheDocument();
		expect(screen.getByText('No Status')).toBeInTheDocument();
	});

	it('buckets an existing record into its matching column', () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'Board',
			schema: [
				{ key: 'title', label: 'Title', type: 'text' },
				{
					key: 'status',
					label: 'Status',
					type: 'select',
					options: [{ id: 'done', label: 'Done' }]
				}
			]
		});
		createRecord(
			ydoc,
			{
				parentId: 'col-1',
				properties: {
					title: { type: 'text', value: 'Ship it' },
					status: { type: 'select', value: 'done' }
				}
			},
			actor
		);
		render(Page, {
			params: { id: 'col-1' },
			form: null,
			data: { documents: [], collections: [], collectionId: 'col-1', title: 'Board' }
		});

		expect(screen.getByText('Ship it')).toBeInTheDocument();
	});

	it('adds a card to a specific column via its "Add card" button', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'Board',
			schema: [
				{
					key: 'status',
					label: 'Status',
					type: 'select',
					options: [{ id: 'done', label: 'Done' }]
				}
			]
		});
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'col-1' },
			form: null,
			data: { documents: [], collections: [], collectionId: 'col-1', title: 'Board' }
		});

		await user.click(screen.getByRole('button', { name: 'Add card to Done' }));

		expect(screen.getByText('Untitled')).toBeInTheDocument();
	});

	it('deletes a card via its trash button', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'Board',
			schema: [
				{ key: 'title', label: 'Title', type: 'text' },
				{ key: 'status', label: 'Status', type: 'select', options: [] }
			]
		});
		const record = createRecord(
			ydoc,
			{ parentId: 'col-1', properties: { title: { type: 'text', value: 'Doomed card' } } },
			actor
		);
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'col-1' },
			form: null,
			data: { documents: [], collections: [], collectionId: 'col-1', title: 'Board' }
		});

		expect(screen.getByText('Doomed card')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Delete card' }));

		expect(screen.queryByText('Doomed card')).not.toBeInTheDocument();
		expect(getRecord(ydoc, record.id)).toBeUndefined();
	});

	it('moves a card between columns via drag and drop', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'Board',
			schema: [
				{ key: 'title', label: 'Title', type: 'text' },
				{
					key: 'status',
					label: 'Status',
					type: 'select',
					options: [
						{ id: 'todo', label: 'To do' },
						{ id: 'done', label: 'Done' }
					]
				}
			]
		});
		const record = createRecord(
			ydoc,
			{
				parentId: 'col-1',
				properties: {
					title: { type: 'text', value: 'Movable' },
					status: { type: 'select', value: 'todo' }
				}
			},
			actor
		);
		render(Page, {
			params: { id: 'col-1' },
			form: null,
			data: { documents: [], collections: [], collectionId: 'col-1', title: 'Board' }
		});

		const card = screen.getByText('Movable').closest('[draggable="true"]') as HTMLElement;
		const doneColumn = screen.getByRole('group', { name: 'Done column' });

		const { fireEvent } = await import('@testing-library/dom');
		const dataTransfer = { setData: vi.fn(), getData: vi.fn() };
		await fireEvent.dragStart(card, { dataTransfer });
		await fireEvent.drop(doneColumn, { dataTransfer });

		expect(getRecord(ydoc, record.id)?.properties?.status).toEqual({
			type: 'select',
			value: 'done'
		});
	});

	it('moves a card between columns via the keyboard-accessible "Move to" select', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'Board',
			schema: [
				{ key: 'title', label: 'Title', type: 'text' },
				{
					key: 'status',
					label: 'Status',
					type: 'select',
					options: [
						{ id: 'todo', label: 'To do' },
						{ id: 'done', label: 'Done' }
					]
				}
			]
		});
		const record = createRecord(
			ydoc,
			{
				parentId: 'col-1',
				properties: {
					title: { type: 'text', value: 'Movable' },
					status: { type: 'select', value: 'todo' }
				}
			},
			actor
		);
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'col-1' },
			form: null,
			data: { documents: [], collections: [], collectionId: 'col-1', title: 'Board' }
		});

		const moveSelect = screen.getByLabelText('Move Movable to column');
		await user.selectOptions(moveSelect, 'done');

		expect(getRecord(ydoc, record.id)?.properties?.status).toEqual({
			type: 'select',
			value: 'done'
		});
	});

	it('adds a new option to a non-grouping select field from a card', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'Board',
			schema: [
				{
					key: 'status',
					label: 'Status',
					type: 'select',
					options: [{ id: 'todo', label: 'To do' }]
				},
				{ key: 'priority', label: 'Priority', type: 'select', options: [] }
			]
		});
		createRecord(
			ydoc,
			{ parentId: 'col-1', properties: { status: { type: 'select', value: 'todo' } } },
			actor
		);
		vi.spyOn(window, 'prompt').mockReturnValue('High');
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'col-1' },
			form: null,
			data: { documents: [], collections: [], collectionId: 'col-1', title: 'Board' }
		});

		await user.click(screen.getByTitle('Add option'));

		const collection = ydoc.getMap('collections').get('col-1') as Y.Map<unknown>;
		const schema = collection.get('schema') as {
			key: string;
			options?: { label: string }[];
		}[];
		const status = schema.find((p) => p.key === 'status');
		const priority = schema.find((p) => p.key === 'priority');
		// The "+" clicked belongs to the Priority field rendered on the card,
		// not the Status grouping column — it must never mutate Status's options.
		expect(priority?.options?.map((o) => o.label)).toEqual(['High']);
		expect(status?.options?.map((o) => o.label)).toEqual(['To do']);
	});
});
