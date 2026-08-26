import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import ViewToolbarHarness from './ViewToolbarHarness.svelte';
import type { PropertyDefinition } from '$lib/data/types';
import type { ViewConfig } from '$lib/data/views';

const schema: PropertyDefinition[] = [
	{ key: 'title', label: 'Title', type: 'text' },
	{
		key: 'status',
		label: 'Status',
		type: 'select',
		options: [{ id: 'todo', label: 'To do' }]
	}
];

describe('ViewToolbar', () => {
	it('adds a filter row and reflects the count on the toggle button', async () => {
		const user = userEvent.setup();
		render(ViewToolbarHarness, { schema });

		await user.click(screen.getByRole('button', { name: /Filter/ }));
		await user.click(screen.getByRole('button', { name: '+ Add filter' }));

		expect(screen.getByText(/Filter \(1\)/)).toBeInTheDocument();
	});

	it('removes a filter row', async () => {
		const user = userEvent.setup();
		render(ViewToolbarHarness, { schema });

		await user.click(screen.getByRole('button', { name: /Filter/ }));
		await user.click(screen.getByRole('button', { name: '+ Add filter' }));
		expect(screen.getByText(/Filter \(1\)/)).toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'Remove filter' }));
		expect(screen.getByText('No filters yet.')).toBeInTheDocument();
	});

	it('switches sort mode to property and exposes property/direction pickers', async () => {
		const onConfigChange = vi.fn();
		const user = userEvent.setup();
		render(ViewToolbarHarness, { schema, onConfigChange });

		const modeSelect = screen.getAllByRole('combobox')[0];
		await user.selectOptions(modeSelect, 'property');

		expect(screen.getByRole('option', { name: 'Ascending' })).toBeInTheDocument();
		expect(onConfigChange).toHaveBeenLastCalledWith(
			expect.objectContaining({
				sort: { mode: 'property', propertyKey: 'title', direction: 'asc' }
			})
		);
	});

	it('toggles a property out of the visible-fields set', async () => {
		const onConfigChange = vi.fn();
		const user = userEvent.setup();
		render(ViewToolbarHarness, { schema, onConfigChange });

		await user.click(screen.getByRole('button', { name: 'Fields' }));
		const [titleCheckbox] = screen.getAllByRole('checkbox');
		expect(titleCheckbox).toBeChecked();

		await user.click(titleCheckbox);

		expect(titleCheckbox).not.toBeChecked();
		const lastCall: ViewConfig = onConfigChange.mock.calls.at(-1)![0];
		expect(lastCall.visibleProperties).toEqual(['status']);
	});

	it('disables property sort mode when the schema has no properties', async () => {
		const onConfigChange = vi.fn();
		const user = userEvent.setup();
		render(ViewToolbarHarness, { schema: [], onConfigChange });

		const modeSelect = screen.getAllByRole('combobox')[0];
		expect(screen.getByRole('option', { name: 'Sort by property' })).toBeDisabled();
		const callsBeforeAttempt = onConfigChange.mock.calls.length;

		await user.selectOptions(modeSelect, 'property').catch(() => {});

		expect(onConfigChange.mock.calls.length).toBe(callsBeforeAttempt);
		expect(screen.queryByRole('option', { name: 'Ascending' })).not.toBeInTheDocument();
	});
});
