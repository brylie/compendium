import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { createCollection, createRecord, getRecord } from '$lib/data/records';
import type { ViewConfig } from '$lib/data/views';
import BoardCollectionViewHarness from './BoardCollectionViewHarness.svelte';

let ydoc: Y.Doc;
vi.mock('$lib/client/yjs-client', () => ({ getClientDoc: () => ydoc }));

const actor = { kind: 'human' as const, userId: 'local' };

function renderBoard(
	collectionId: string,
	initialConfig: ViewConfig = { sort: { mode: 'manual' } }
) {
	return render(BoardCollectionViewHarness, { collectionId, initialConfig });
}

describe('BoardCollectionView', () => {
	beforeEach(() => {
		ydoc = new Y.Doc();
	});

	afterEach(() => {
		ydoc.destroy();
	});

	it('prompts to add a select property when the collection has none', () => {
		createCollection(ydoc, { id: 'col-1', title: 'Board', schema: [] });
		renderBoard('col-1');
		expect(screen.getByText(/doesn't have one yet/)).toBeInTheDocument();
	});

	it('adds a select property via the prompt', async () => {
		createCollection(ydoc, { id: 'col-1', title: 'Board', schema: [] });
		vi.spyOn(window, 'prompt').mockReturnValue('Status');
		const user = userEvent.setup();
		renderBoard('col-1');

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
		renderBoard('col-1', { sort: { mode: 'manual' }, groupBy: 'status' });

		expect(screen.getByText('To do')).toBeInTheDocument();
		expect(screen.getByText('Done')).toBeInTheDocument();
		expect(screen.getByText('No Status')).toBeInTheDocument();
	});

	it('makes the card title directly editable via its own field', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'Board',
			schema: [
				{ key: 'title', label: 'Title', type: 'text' },
				{ key: 'status', label: 'Status', type: 'select', options: [{ id: 'done', label: 'Done' }] }
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
		const user = userEvent.setup();
		renderBoard('col-1', { sort: { mode: 'manual' }, groupBy: 'status' });

		const titleInput = screen.getByDisplayValue('Ship it');
		await user.clear(titleInput);
		await user.type(titleInput, 'Ship it today');
		await user.tab();

		const record = ydoc.getMap('records');
		const stored = Array.from(record.values()).find(
			(r) => (r as Y.Map<unknown>).get('parentId') === 'col-1'
		) as Y.Map<unknown>;
		expect((stored.get('prop:title') as { value: string }).value).toBe('Ship it today');
	});

	it('adds a card to a specific column via its "Add card" button', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'Board',
			schema: [
				{ key: 'status', label: 'Status', type: 'select', options: [{ id: 'done', label: 'Done' }] }
			]
		});
		const user = userEvent.setup();
		renderBoard('col-1', { sort: { mode: 'manual' }, groupBy: 'status' });

		await user.click(screen.getByRole('button', { name: 'Add card to Done' }));

		expect(screen.getByRole('button', { name: 'Delete card' })).toBeInTheDocument();
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
		renderBoard('col-1', { sort: { mode: 'manual' }, groupBy: 'status' });

		expect(screen.getByDisplayValue('Doomed card')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Delete card' }));

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
		renderBoard('col-1', { sort: { mode: 'manual' }, groupBy: 'status' });

		const card = screen.getByDisplayValue('Movable').closest('[draggable="true"]') as HTMLElement;
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
		renderBoard('col-1', { sort: { mode: 'manual' }, groupBy: 'status' });

		const moveSelect = screen.getByLabelText('Move Movable to column');
		await user.selectOptions(moveSelect, 'done');

		expect(getRecord(ydoc, record.id)?.properties?.status).toEqual({
			type: 'select',
			value: 'done'
		});
	});

	it('adds a new option to a non-grouping select field from a card without touching the grouping property', async () => {
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
		renderBoard('col-1', { sort: { mode: 'manual' }, groupBy: 'status' });

		await user.click(screen.getByTitle('Add option'));

		const collection = ydoc.getMap('collections').get('col-1') as Y.Map<unknown>;
		const schema = collection.get('schema') as { key: string; options?: { label: string }[] }[];
		expect(schema.find((p) => p.key === 'priority')?.options?.map((o) => o.label)).toEqual([
			'High'
		]);
		expect(schema.find((p) => p.key === 'status')?.options?.map((o) => o.label)).toEqual(['To do']);
	});
});
