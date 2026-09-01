import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import PromptDialog from './PromptDialog.svelte';

describe('PromptDialog', () => {
	it('renders nothing when closed', () => {
		render(PromptDialog, {
			open: false,
			title: 'New space',
			label: 'Space name',
			onSubmit: vi.fn(),
			onCancel: vi.fn()
		});
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('renders the title, label, and pre-fills the initial value when open', () => {
		render(PromptDialog, {
			open: true,
			title: 'Rename',
			label: 'New title',
			initialValue: 'Old title',
			onSubmit: vi.fn(),
			onCancel: vi.fn()
		});
		expect(screen.getByRole('dialog')).toBeInTheDocument();
		expect(screen.getByText('Rename')).toBeInTheDocument();
		expect(screen.getByLabelText('New title')).toHaveValue('Old title');
	});

	it('shows an error message as an alert when provided', () => {
		render(PromptDialog, {
			open: true,
			title: 'New space',
			label: 'Space name',
			errorMessage: 'Failed to create space.',
			onSubmit: vi.fn(),
			onCancel: vi.fn()
		});
		expect(screen.getByRole('alert')).toHaveTextContent('Failed to create space.');
	});

	it('renders a custom submit label', () => {
		render(PromptDialog, {
			open: true,
			title: 'New space',
			label: 'Space name',
			submitLabel: 'Create',
			onSubmit: vi.fn(),
			onCancel: vi.fn()
		});
		expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
	});

	it('calls onCancel when Cancel is clicked', async () => {
		const user = userEvent.setup();
		const onCancel = vi.fn();
		render(PromptDialog, {
			open: true,
			title: 'New space',
			label: 'Space name',
			onSubmit: vi.fn(),
			onCancel
		});
		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it('calls onSubmit with the typed value on submit', async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		render(PromptDialog, {
			open: true,
			title: 'New space',
			label: 'Space name',
			submitLabel: 'Save',
			onSubmit,
			onCancel: vi.fn()
		});
		await user.type(screen.getByLabelText('Space name'), 'Marketing');
		await user.click(screen.getByRole('button', { name: 'Save' }));
		expect(onSubmit).toHaveBeenCalledWith('Marketing');
	});

	it('calls onCancel on Escape', async () => {
		const user = userEvent.setup();
		const onCancel = vi.fn();
		render(PromptDialog, {
			open: true,
			title: 'New space',
			label: 'Space name',
			onSubmit: vi.fn(),
			onCancel
		});
		screen.getByRole('dialog').focus();
		await user.keyboard('{Escape}');
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it('wraps Tab from the last focusable control back to the first', async () => {
		const user = userEvent.setup();
		render(PromptDialog, {
			open: true,
			title: 'New space',
			label: 'Space name',
			onSubmit: vi.fn(),
			onCancel: vi.fn()
		});

		const input = screen.getByLabelText('Space name');
		const saveButton = screen.getByRole('button', { name: 'Save' });
		await vi.waitFor(() => expect(document.activeElement).toBe(input));
		saveButton.focus();
		await user.keyboard('{Tab}');
		expect(document.activeElement).toBe(input);
	});

	it('wraps Shift+Tab from the first focusable control back to the last', async () => {
		const user = userEvent.setup();
		render(PromptDialog, {
			open: true,
			title: 'New space',
			label: 'Space name',
			onSubmit: vi.fn(),
			onCancel: vi.fn()
		});

		const input = screen.getByLabelText('Space name');
		const saveButton = screen.getByRole('button', { name: 'Save' });
		await vi.waitFor(() => expect(document.activeElement).toBe(input));
		await user.keyboard('{Shift>}{Tab}{/Shift}');
		expect(document.activeElement).toBe(saveButton);
	});
});
