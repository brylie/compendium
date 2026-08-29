import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { createCollection, createRecord, getCollection, getRecord } from '$lib/data/records';
import type { ViewConfig } from '$lib/data/views';
import CalendarCollectionViewHarness from './CalendarCollectionViewHarness.svelte';

let ydoc: Y.Doc;
vi.mock('$lib/client/yjs-client', () => ({ getClientDoc: () => ydoc }));

const actor = { kind: 'human' as const, userId: 'local' };

function renderCalendar(collectionId: string, initialConfig: ViewConfig = {}) {
	return render(CalendarCollectionViewHarness, { collectionId, initialConfig });
}

describe('CalendarCollectionView', () => {
	beforeEach(() => {
		ydoc = new Y.Doc();
		vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));
	});

	afterEach(() => {
		ydoc.destroy();
		vi.useRealTimers();
	});

	it('prompts to add a date property when the collection has none', () => {
		createCollection(ydoc, { id: 'col-1', title: 'Cal', schema: [] });
		renderCalendar('col-1');
		expect(screen.getByText(/doesn't have one yet/)).toBeInTheDocument();
	});

	it('adds a date property from the inline empty-state form and switches into the calendar grid', async () => {
		createCollection(ydoc, { id: 'col-1', title: 'Cal', schema: [] });
		const user = userEvent.setup();
		renderCalendar('col-1');

		expect(screen.getByRole('textbox', { name: 'Date property name' })).toHaveValue('Date');
		await user.click(screen.getByRole('button', { name: 'Add a date property' }));

		expect(screen.getByRole('option', { name: 'Date' })).toBeInTheDocument();
		expect(screen.getByText('March 2026')).toBeInTheDocument();
		expect(getCollection(ydoc, 'col-1')?.schema).toEqual([
			expect.objectContaining({ label: 'Date', type: 'date' })
		]);
	});

	it('places a record on its matching day cell', () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'Cal',
			schema: [
				{ key: 'title', label: 'Title', type: 'text' },
				{ key: 'due', label: 'Due', type: 'date' }
			]
		});
		createRecord(
			ydoc,
			{
				parentId: 'col-1',
				properties: {
					title: { type: 'text', value: 'Launch' },
					due: { type: 'date', value: '2026-03-20' }
				}
			},
			actor
		);
		renderCalendar('col-1', { groupBy: 'due' });

		expect(screen.getByText('Launch')).toBeInTheDocument();
		expect(screen.queryByText('Unscheduled')).not.toBeInTheDocument();
	});

	it('lists a record with no date value under Unscheduled', () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'Cal',
			schema: [
				{ key: 'title', label: 'Title', type: 'text' },
				{ key: 'due', label: 'Due', type: 'date' }
			]
		});
		createRecord(
			ydoc,
			{ parentId: 'col-1', properties: { title: { type: 'text', value: 'No date yet' } } },
			actor
		);
		renderCalendar('col-1', { groupBy: 'due' });

		expect(screen.getByText('Unscheduled')).toBeInTheDocument();
		expect(screen.getByText('No date yet')).toBeInTheDocument();
	});

	it('adds an entry on a specific day via that cell\'s "+" button', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'Cal',
			schema: [{ key: 'due', label: 'Due', type: 'date' }]
		});
		const user = userEvent.setup();
		renderCalendar('col-1', { groupBy: 'due' });

		await user.click(screen.getByRole('button', { name: 'Add entry on 2026-03-20' }));

		const created = Array.from(ydoc.getMap('records').values()).find(
			(v) => (v as Y.Map<unknown>).get('parentId') === 'col-1'
		) as Y.Map<unknown>;
		expect((created.get('prop:due') as { value: string }).value).toBe('2026-03-20');
	});

	it('reschedules an entry by editing its date field directly', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'Cal',
			schema: [
				{ key: 'title', label: 'Title', type: 'text' },
				{ key: 'due', label: 'Due', type: 'date' }
			]
		});
		const record = createRecord(
			ydoc,
			{
				parentId: 'col-1',
				properties: {
					title: { type: 'text', value: 'Reschedule me' },
					due: { type: 'date', value: '2026-03-05' }
				}
			},
			actor
		);
		renderCalendar('col-1', { groupBy: 'due' });

		const dateInput = screen.getByDisplayValue('2026-03-05');
		await fireEvent.change(dateInput, { target: { value: '2026-03-25' } });

		expect(getRecord(ydoc, record.id)?.properties?.due).toEqual({
			type: 'date',
			value: '2026-03-25'
		});
	});

	it('sets a date on an unscheduled record from its inline date field', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'Cal',
			schema: [
				{ key: 'title', label: 'Title', type: 'text' },
				{ key: 'due', label: 'Due', type: 'date' }
			]
		});
		const record = createRecord(
			ydoc,
			{ parentId: 'col-1', properties: { title: { type: 'text', value: 'Needs a date' } } },
			actor
		);
		renderCalendar('col-1', { groupBy: 'due' });

		const unscheduledSection = screen.getByText('Unscheduled').closest('section')!;
		const dateInput = within(unscheduledSection).getByDisplayValue('');
		await fireEvent.change(dateInput, { target: { value: '2026-03-10' } });

		expect(getRecord(ydoc, record.id)?.properties?.due).toEqual({
			type: 'date',
			value: '2026-03-10'
		});
	});

	it('adds a select option through the in-page dialog', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'Cal',
			schema: [
				{ key: 'due', label: 'Due', type: 'date' },
				{ key: 'status', label: 'Status', type: 'select', options: [] }
			]
		});
		createRecord(
			ydoc,
			{
				parentId: 'col-1',
				properties: { due: { type: 'date', value: '2026-03-20' } }
			},
			actor
		);
		const user = userEvent.setup();
		renderCalendar('col-1', { groupBy: 'due' });

		await user.click(screen.getByTitle('Add option'));
		await user.type(screen.getByLabelText('Option name'), 'Ready');
		await user.click(
			within(screen.getByRole('dialog')).getByRole('button', { name: 'Add option' })
		);

		expect(getCollection(ydoc, 'col-1')?.schema[1].options).toEqual([
			expect.objectContaining({ label: 'Ready' })
		]);
	});

	it('deletes an entry via its trash button', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'Cal',
			schema: [
				{ key: 'title', label: 'Title', type: 'text' },
				{ key: 'due', label: 'Due', type: 'date' }
			]
		});
		const record = createRecord(
			ydoc,
			{
				parentId: 'col-1',
				properties: {
					title: { type: 'text', value: 'Doomed entry' },
					due: { type: 'date', value: '2026-03-20' }
				}
			},
			actor
		);
		const user = userEvent.setup();
		renderCalendar('col-1', { groupBy: 'due' });

		await user.click(screen.getByRole('button', { name: 'Delete entry' }));

		expect(getRecord(ydoc, record.id)).toBeUndefined();
	});

	it('navigates between months and back to today', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'Cal',
			schema: [{ key: 'due', label: 'Due', type: 'date' }]
		});
		const user = userEvent.setup();
		renderCalendar('col-1', { groupBy: 'due' });

		expect(screen.getByText('March 2026')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Next month' }));
		expect(screen.getByText('April 2026')).toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Today' }));
		expect(screen.getByText('March 2026')).toBeInTheDocument();
	});
});
