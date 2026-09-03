import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import PropertyValueCell from './PropertyValueCell.svelte';
import { createCollection, createRecord } from '$lib/data/records';
import type { ActorId, PropertyDefinition } from '$lib/data/types';

// RelationPropertyCell (rendered for property.type === 'relation') resolves
// its target Collection via resolveCollectionDoc, not the getShardDoc/fetch
// pairing every other Collection-content view uses directly — mocked
// straight to a pre-built local doc rather than also stubbing fetch, since
// this component never calls it itself.
let relationDoc: Y.Doc;
vi.mock('$lib/client/yjs-client', () => ({
	resolveCollectionDoc: () => Promise.resolve(relationDoc)
}));

const actor: ActorId = { kind: 'human', userId: 'local' };

describe('PropertyValueCell', () => {
	it('renders and edits a text property', async () => {
		const oninput = vi.fn();
		const user = userEvent.setup();
		const property: PropertyDefinition = { key: 'name', label: 'Name', type: 'text' };
		render(PropertyValueCell, { property, value: undefined, oninput });

		const input = screen.getByRole('textbox');
		await user.type(input, 'Alice');
		await user.tab();

		expect(oninput).toHaveBeenCalledWith({ type: 'text', value: 'Alice' });
	});

	it('renders and edits a number property', async () => {
		const oninput = vi.fn();
		const user = userEvent.setup();
		const property: PropertyDefinition = { key: 'qty', label: 'Qty', type: 'number' };
		render(PropertyValueCell, {
			property,
			value: { type: 'number', value: 1 },
			oninput
		});

		const input = screen.getByDisplayValue('1');
		await user.clear(input);
		await user.type(input, '9');
		await user.tab();

		expect(oninput).toHaveBeenCalledWith({ type: 'number', value: 9 });
	});

	it('does not write 0 when a number field is cleared', async () => {
		const oninput = vi.fn();
		const user = userEvent.setup();
		const property: PropertyDefinition = { key: 'qty', label: 'Qty', type: 'number' };
		render(PropertyValueCell, {
			property,
			value: { type: 'number', value: 5 },
			oninput
		});

		const input = screen.getByDisplayValue('5');
		await user.clear(input);
		await user.tab();

		expect(oninput).not.toHaveBeenCalled();
	});

	it('renders and edits a date property', async () => {
		const oninput = vi.fn();
		const user = userEvent.setup();
		const property: PropertyDefinition = { key: 'due', label: 'Due', type: 'date' };
		render(PropertyValueCell, { property, value: undefined, oninput });

		const input = screen.getByDisplayValue('');
		await user.type(input, '2026-03-15');
		await user.tab();

		expect(oninput).toHaveBeenCalledWith({ type: 'date', value: '2026-03-15' });
	});

	it('renders and toggles a checkbox property', async () => {
		const oninput = vi.fn();
		const user = userEvent.setup();
		const property: PropertyDefinition = { key: 'done', label: 'Done', type: 'checkbox' };
		render(PropertyValueCell, {
			property,
			value: { type: 'checkbox', value: false },
			oninput
		});

		await user.click(screen.getByRole('checkbox'));
		expect(oninput).toHaveBeenCalledWith({ type: 'checkbox', value: true });
	});

	it('renders a select property and calls onAddOption from its "+" button', async () => {
		const oninput = vi.fn();
		const onAddOption = vi.fn();
		const user = userEvent.setup();
		const property: PropertyDefinition = {
			key: 'status',
			label: 'Status',
			type: 'select',
			options: [{ id: 'opt-1', label: 'Open' }]
		};
		render(PropertyValueCell, { property, value: undefined, oninput, onAddOption });

		await user.selectOptions(screen.getByRole('combobox'), 'opt-1');
		expect(oninput).toHaveBeenCalledWith({ type: 'select', value: 'opt-1' });

		await user.click(screen.getByTitle('Add option'));
		expect(onAddOption).toHaveBeenCalledOnce();
	});

	it('omits the "+" button for a select property when onAddOption is not provided', () => {
		const property: PropertyDefinition = {
			key: 'status',
			label: 'Status',
			type: 'select',
			options: []
		};
		render(PropertyValueCell, { property, value: undefined, oninput: vi.fn() });
		expect(screen.queryByTitle('Add option')).not.toBeInTheDocument();
	});

	describe('relation property (issue #15)', () => {
		it('shows a placeholder instead of a picker when no target collection is configured', () => {
			const property: PropertyDefinition = { key: 'links', label: 'Links', type: 'relation' };
			render(PropertyValueCell, { property, value: undefined, oninput: vi.fn() });
			expect(screen.getByText('No target collection set')).toBeInTheDocument();
			expect(screen.queryByRole('button', { name: 'Add Links' })).not.toBeInTheDocument();
		});

		it("resolves selected ids to the target Collection's records, and adds/removes via the picker", async () => {
			relationDoc = new Y.Doc();
			const target = createCollection(relationDoc, {
				title: 'People',
				schema: [{ key: 'name', label: 'Name', type: 'text' }]
			});
			const alice = createRecord(
				relationDoc,
				{ parentId: target.id, properties: { name: { type: 'text', value: 'Alice' } } },
				actor
			);
			const bob = createRecord(
				relationDoc,
				{ parentId: target.id, properties: { name: { type: 'text', value: 'Bob' } } },
				actor
			);

			const oninput = vi.fn();
			const user = userEvent.setup();
			const property: PropertyDefinition = {
				key: 'assignee',
				label: 'Assignee',
				type: 'relation',
				targetCollectionId: target.id
			};
			render(PropertyValueCell, {
				property,
				value: { type: 'relation', value: [alice.id] },
				oninput
			});

			await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());

			await user.click(screen.getByRole('button', { name: 'Add Assignee' }));
			await user.type(screen.getByPlaceholderText(/Search/), 'Bob');
			await user.click(await screen.findByRole('button', { name: 'Bob' }));
			expect(oninput).toHaveBeenCalledWith({ type: 'relation', value: [alice.id, bob.id] });

			await user.click(screen.getByRole('button', { name: 'Remove Alice' }));
			expect(oninput).toHaveBeenCalledWith({ type: 'relation', value: [] });
		});

		it('renders a value pointing at a deleted record as a distinct broken chip, keeping the id', async () => {
			relationDoc = new Y.Doc();
			const target = createCollection(relationDoc, { title: 'People', schema: [] });
			const property: PropertyDefinition = {
				key: 'assignee',
				label: 'Assignee',
				type: 'relation',
				targetCollectionId: target.id
			};
			render(PropertyValueCell, {
				property,
				value: { type: 'relation', value: ['missing-id'] },
				oninput: vi.fn()
			});

			await waitFor(() => expect(screen.getByText('missing-id')).toBeInTheDocument());
			expect(screen.getByTitle('Linked record was deleted')).toBeInTheDocument();
		});
	});
});
