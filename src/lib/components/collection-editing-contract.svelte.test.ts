// Cross-surface contract tests for issue #189: adding a select option through
// any of the four Collection renderers (embedded Table, embedded Board,
// embedded Calendar, and the full-page /table/[id] route) must go through
// the same validated, deduped, palette-colored `addSelectOption` primitive
// and produce identical schema state and identical validation errors —
// not the renderer-specific, hand-rolled schema rebuilds that let Calendar
// and the full-page route silently create duplicate, uncolored options
// before this fix.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { createCollection, createRecord, getCollection } from '$lib/data/records';
import { SELECT_OPTION_COLORS } from '$lib/data/select-colors';
import TableCollectionViewHarness from './TableCollectionViewHarness.svelte';
import BoardCollectionViewHarness from './BoardCollectionViewHarness.svelte';
import CalendarCollectionViewHarness from './CalendarCollectionViewHarness.svelte';
import FullPageTable from '../../routes/space/[spaceId]/table/[id]/+page.svelte';

const actor = { kind: 'human' as const, userId: 'local' };

let ydoc: Y.Doc;
vi.mock('$app/state', () => ({
	get page() {
		return { params: { spaceId: 'space-1' } };
	}
}));
vi.mock('$lib/client/yjs-client', () => ({
	getClientDoc: () => ydoc,
	getShardDoc: () => ydoc,
	resolveCollectionDoc: () => Promise.resolve(ydoc)
}));

async function flushShardResolution(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Every surface's dialog ends up with the same one-line validation error for a duplicate label — assert on that text regardless of which renderer's dialog copy ("New option" vs "New column") is showing. */
function expectDuplicateRejection(): void {
	expect(
		within(screen.getByRole('dialog')).getByText('An option named "Done" already exists')
	).toBeInTheDocument();
}

describe('cross-surface select-option contract (issue #189)', () => {
	beforeEach(() => {
		ydoc = new Y.Doc();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ json: async () => ({ shardId: 'test-shard' }) }))
		);
	});

	afterEach(() => {
		ydoc.destroy();
		vi.unstubAllGlobals();
	});

	it('Table: adds a validated, palette-colored option and rejects a duplicate label', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'T',
			schema: [{ key: 'status', label: 'Status', type: 'select', options: [] }]
		});
		createRecord(ydoc, { parentId: 'col-1', properties: {} }, actor);
		const user = userEvent.setup();
		render(TableCollectionViewHarness, { collectionId: 'col-1' });

		await user.click(await screen.findByTitle('Add option'));
		await user.type(screen.getByLabelText('Option name'), 'Done');
		await user.click(
			within(screen.getByRole('dialog')).getByRole('button', { name: 'Add option' })
		);

		expect(getCollection(ydoc, 'col-1')?.schema).toEqual([
			expect.objectContaining({
				key: 'status',
				options: [{ id: expect.any(String), label: 'Done', color: SELECT_OPTION_COLORS[0].value }]
			})
		]);

		await user.click(screen.getByTitle('Add option'));
		await user.type(screen.getByLabelText('Option name'), 'Done');
		await user.click(
			within(screen.getByRole('dialog')).getByRole('button', { name: 'Add option' })
		);
		expectDuplicateRejection();
	});

	it('Board: adding a column goes through the same validated, colored path and rejects a duplicate label', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'T',
			schema: [{ key: 'status', label: 'Status', type: 'select', options: [] }]
		});
		const user = userEvent.setup();
		render(BoardCollectionViewHarness, { collectionId: 'col-1' });

		await user.click(await screen.findByRole('button', { name: '+ Add column' }));
		await user.type(screen.getByLabelText('Column name'), 'Done');
		await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add' }));

		expect(getCollection(ydoc, 'col-1')?.schema).toEqual([
			expect.objectContaining({
				key: 'status',
				options: [{ id: expect.any(String), label: 'Done', color: SELECT_OPTION_COLORS[0].value }]
			})
		]);

		await user.click(screen.getByRole('button', { name: '+ Add column' }));
		await user.type(screen.getByLabelText('Column name'), 'Done');
		await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Add' }));
		expectDuplicateRejection();
	});

	it('Calendar: adding an option on an entry field is now validated, colored, and rejects a duplicate — previously this bypassed addSelectOption entirely', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'T',
			schema: [
				{ key: 'due', label: 'Due', type: 'date' },
				{ key: 'status', label: 'Status', type: 'select', options: [] }
			]
		});
		// Placed on today's date, not a fixed one — the calendar only renders
		// the currently-displayed month (defaulting to the current one), and a
		// fixed past/future date would silently fall outside that grid.
		const today = new Date();
		const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
		createRecord(
			ydoc,
			{ parentId: 'col-1', properties: { due: { type: 'date', value: todayKey } } },
			actor
		);
		const user = userEvent.setup();
		render(CalendarCollectionViewHarness, {
			collectionId: 'col-1',
			initialConfig: { groupBy: 'due' }
		});

		await user.click(await screen.findByTitle('Add option'));
		await user.type(screen.getByLabelText('Option name'), 'Done');
		await user.click(
			within(screen.getByRole('dialog')).getByRole('button', { name: 'Add option' })
		);

		expect(getCollection(ydoc, 'col-1')?.schema).toEqual([
			expect.objectContaining({ key: 'due' }),
			expect.objectContaining({
				key: 'status',
				options: [{ id: expect.any(String), label: 'Done', color: SELECT_OPTION_COLORS[0].value }]
			})
		]);

		await user.click(screen.getByTitle('Add option'));
		await user.type(screen.getByLabelText('Option name'), 'Done');
		await user.click(
			within(screen.getByRole('dialog')).getByRole('button', { name: 'Add option' })
		);
		expectDuplicateRejection();
	});

	it('Full-page Table route: adding an option now goes through the same validated, colored path (composed from the embedded Table renderer) and rejects a duplicate — previously this bypassed addSelectOption entirely', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'T',
			schema: [{ key: 'status', label: 'Status', type: 'select', options: [] }]
		});
		createRecord(ydoc, { parentId: 'col-1', properties: {} }, actor);
		const user = userEvent.setup();
		render(FullPageTable, {
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

		expect(getCollection(ydoc, 'col-1')?.schema).toEqual([
			expect.objectContaining({
				key: 'status',
				options: [{ id: expect.any(String), label: 'Done', color: SELECT_OPTION_COLORS[0].value }]
			})
		]);

		await user.click(screen.getByTitle('Add option'));
		await user.type(screen.getByLabelText('Option name'), 'Done');
		await user.click(
			within(screen.getByRole('dialog')).getByRole('button', { name: 'Add option' })
		);
		expectDuplicateRejection();
	});
});

describe('cross-surface row attribution contract (issue #189)', () => {
	beforeEach(() => {
		ydoc = new Y.Doc();
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ json: async () => ({ shardId: 'test-shard' }) }))
		);
	});

	afterEach(() => {
		ydoc.destroy();
		vi.unstubAllGlobals();
	});

	it('Table and the full-page route attribute a newly created row to the same actor via the shared createCollectionRow helper', async () => {
		createCollection(ydoc, {
			id: 'col-1',
			title: 'T',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		const user = userEvent.setup();
		const { unmount } = render(TableCollectionViewHarness, { collectionId: 'col-1' });
		await user.click(await screen.findByRole('button', { name: 'Add row' }));
		const [tableRow] = Object.values(
			ydoc.getMap('records').toJSON() as Record<string, { createdBy?: unknown }>
		);
		unmount();
		ydoc.getMap('records').clear();

		createCollection(ydoc, {
			id: 'col-2',
			title: 'T',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		render(FullPageTable, {
			params: { spaceId: 'space-1', id: 'col-2' },
			form: null,
			data: {
				spaces: [],
				spaceId: 'space-1',
				activeSpaceId: 'space-1',
				documents: [],
				collections: [],
				collectionId: 'col-2',
				title: 'T'
			}
		});
		await flushShardResolution();
		await user.click(screen.getByRole('button', { name: 'Add row' }));
		const [fullPageRow] = Object.values(
			ydoc.getMap('records').toJSON() as Record<string, { createdBy?: unknown }>
		);

		expect(fullPageRow.createdBy).toEqual(tableRow.createdBy);
		expect(fullPageRow.createdBy).toEqual({ kind: 'human', userId: 'local' });
	});
});
