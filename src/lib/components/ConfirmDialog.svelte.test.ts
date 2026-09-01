import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import ConfirmDialog from './ConfirmDialog.svelte';

describe('ConfirmDialog', () => {
	it('renders nothing when closed', () => {
		render(ConfirmDialog, {
			open: false,
			title: 'Delete?',
			message: 'Are you sure?',
			onConfirm: vi.fn(),
			onCancel: vi.fn()
		});
		expect(screen.queryByRole('dialog')).toBeNull();
	});

	it('renders the title, message, and default confirm label when open', () => {
		render(ConfirmDialog, {
			open: true,
			title: 'Delete document?',
			message: 'This cannot be undone.',
			onConfirm: vi.fn(),
			onCancel: vi.fn()
		});
		expect(screen.getByRole('dialog')).toBeInTheDocument();
		expect(screen.getByText('Delete document?')).toBeInTheDocument();
		expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
	});

	it('renders a custom confirm label', () => {
		render(ConfirmDialog, {
			open: true,
			title: 'Delete?',
			message: 'Sure?',
			confirmLabel: 'Delete forever',
			onConfirm: vi.fn(),
			onCancel: vi.fn()
		});
		expect(screen.getByRole('button', { name: 'Delete forever' })).toBeInTheDocument();
	});

	it('calls onCancel when Cancel is clicked, and onConfirm when confirmed', async () => {
		const user = userEvent.setup();
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		render(ConfirmDialog, {
			open: true,
			title: 'Delete?',
			message: 'Sure?',
			onConfirm,
			onCancel
		});

		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(onCancel).toHaveBeenCalledOnce();

		await user.click(screen.getByRole('button', { name: 'Confirm' }));
		expect(onConfirm).toHaveBeenCalledOnce();
	});

	it('calls onCancel on Escape, without letting it bubble to an outer handler', async () => {
		const user = userEvent.setup();
		const onCancel = vi.fn();
		const outerKeydown = vi.fn();
		document.addEventListener('keydown', outerKeydown);
		render(ConfirmDialog, {
			open: true,
			title: 'Delete?',
			message: 'Sure?',
			onConfirm: vi.fn(),
			onCancel
		});

		screen.getByRole('dialog').focus();
		await user.keyboard('{Escape}');
		expect(onCancel).toHaveBeenCalledOnce();
		expect(outerKeydown).not.toHaveBeenCalled();
		document.removeEventListener('keydown', outerKeydown);
	});

	it('wraps Tab from the last focusable button back to the first', async () => {
		const user = userEvent.setup();
		render(ConfirmDialog, {
			open: true,
			title: 'Delete?',
			message: 'Sure?',
			onConfirm: vi.fn(),
			onCancel: vi.fn()
		});

		const cancelButton = screen.getByRole('button', { name: 'Cancel' });
		const confirmButton = screen.getByRole('button', { name: 'Confirm' });
		// The dialog's own mount effect auto-focuses Cancel asynchronously (via
		// tick()) — wait for that to settle before moving focus ourselves, or it
		// races our explicit confirmButton.focus() below and silently wins.
		await vi.waitFor(() => expect(document.activeElement).toBe(cancelButton));
		confirmButton.focus();
		await user.keyboard('{Tab}');
		expect(document.activeElement).toBe(cancelButton);
	});

	it('wraps Shift+Tab from the first focusable button back to the last', async () => {
		const user = userEvent.setup();
		render(ConfirmDialog, {
			open: true,
			title: 'Delete?',
			message: 'Sure?',
			onConfirm: vi.fn(),
			onCancel: vi.fn()
		});

		const cancelButton = screen.getByRole('button', { name: 'Cancel' });
		const confirmButton = screen.getByRole('button', { name: 'Confirm' });
		cancelButton.focus();
		await user.keyboard('{Shift>}{Tab}{/Shift}');
		expect(document.activeElement).toBe(confirmButton);
	});
});
