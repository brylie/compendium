import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import PropertyValueCell from './PropertyValueCell.svelte';
import type { PropertyDefinition } from '$lib/data/types';

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

	it('renders and edits a relation property as a comma-separated id list', async () => {
		const oninput = vi.fn();
		const user = userEvent.setup();
		const property: PropertyDefinition = { key: 'links', label: 'Links', type: 'relation' };
		render(PropertyValueCell, {
			property,
			value: { type: 'relation', value: ['rec-a'] },
			oninput
		});

		const input = screen.getByDisplayValue('rec-a');
		await user.clear(input);
		await user.type(input, 'rec-b, rec-c');
		await user.tab();

		expect(oninput).toHaveBeenCalledWith({ type: 'relation', value: ['rec-b', 'rec-c'] });
	});
});
