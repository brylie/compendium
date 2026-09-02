import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import Toolbar from './Toolbar.svelte';

describe('Toolbar', () => {
	it('renders the registered formatting and block-insert controls', () => {
		render(Toolbar, { hasActiveEditor: false, onFormat: vi.fn(), onInsert: vi.fn() });

		expect(screen.getByRole('toolbar', { name: 'Document toolbar' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Bold' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Insert Heading 1' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Insert Heading 4' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Insert Table' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Insert Link to page' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Insert Embed' })).toBeInTheDocument();
	});

	it('renders a Lucide icon for every registered control', () => {
		render(Toolbar, { hasActiveEditor: true, onFormat: vi.fn(), onInsert: vi.fn() });

		for (const button of screen.getAllByRole('button')) {
			expect(button.querySelector('svg.lucide')).toBeInTheDocument();
		}
	});

	it('dispatches registered formatting and insertion actions', async () => {
		const onFormat = vi.fn();
		const onInsert = vi.fn();
		const user = userEvent.setup();
		render(Toolbar, { hasActiveEditor: true, onFormat, onInsert });

		await user.click(screen.getByRole('button', { name: 'Bold' }));
		await user.click(screen.getByRole('button', { name: 'Insert Table' }));

		expect(onFormat).toHaveBeenCalledWith('bold');
		expect(onInsert).toHaveBeenCalledWith('table');
	});

	it('shows the active selection state on the matching formatting control', () => {
		render(Toolbar, {
			hasActiveEditor: true,
			activeMarks: { italic: true },
			onFormat: vi.fn(),
			onInsert: vi.fn()
		});

		expect(screen.getByRole('button', { name: 'Italic' })).toHaveAttribute('aria-pressed', 'true');
		expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'false');
	});

	it('gives every control a visible, non-announced tooltip alongside its accessible name', () => {
		render(Toolbar, { hasActiveEditor: true, onFormat: vi.fn(), onInsert: vi.fn() });

		for (const button of screen.getAllByRole('button')) {
			const wrapper = button.parentElement;
			const tooltip = wrapper?.querySelector('[role="tooltip"]');
			expect(tooltip, `expected a tooltip for "${button.getAttribute('aria-label')}"`).toBeTruthy();
			// aria-hidden: the accessible name already comes from aria-label on the
			// button; this tooltip is a sighted-user affordance only, so it must
			// not be announced a second time by assistive tech.
			expect(tooltip).toHaveAttribute('aria-hidden', 'true');
		}
	});

	it('never wraps the toolbar onto a second row', () => {
		render(Toolbar, { hasActiveEditor: true, onFormat: vi.fn(), onInsert: vi.fn() });

		const toolbar = screen.getByRole('toolbar', { name: 'Document toolbar' });
		expect(toolbar).not.toHaveClass('flex-wrap');
		expect(toolbar).toHaveClass('flex-nowrap');
	});

	it('shows every insert control inline with no overflow trigger before the container is measured', () => {
		// jsdom never reports a real clientWidth (no layout engine), so this
		// also documents the real app's behavior for the first render before
		// bind:clientWidth's initial measurement lands.
		render(Toolbar, { hasActiveEditor: true, onFormat: vi.fn(), onInsert: vi.fn() });

		expect(screen.getByRole('button', { name: 'Insert Embed' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'More blocks' })).not.toBeInTheDocument();
	});

	it('collapses controls that do not fit behind a "More blocks" dropdown instead of scrolling', async () => {
		const onInsert = vi.fn();
		const user = userEvent.setup();
		// Forced narrow width instead of a real scrollbar: this is the same
		// state bind:clientWidth would set on a real narrow viewport.
		render(Toolbar, {
			hasActiveEditor: true,
			insertGroupWidthOverride: 80,
			onFormat: vi.fn(),
			onInsert
		});

		expect(screen.queryByRole('button', { name: 'Insert Embed' })).not.toBeInTheDocument();
		const trigger = screen.getByRole('button', { name: 'More blocks' });
		expect(trigger).toHaveAttribute('aria-expanded', 'false');

		await user.click(trigger);

		expect(trigger).toHaveAttribute('aria-expanded', 'true');
		const panel = screen.getByRole('listbox', { name: 'More blocks' });
		const embedOption = within(panel).getByRole('option', { name: 'Embed' });
		await user.click(embedOption);

		expect(onInsert).toHaveBeenCalledWith('embed');
		expect(screen.queryByRole('listbox', { name: 'More blocks' })).not.toBeInTheDocument();
	});

	it('closes the overflow dropdown on outside click and on Escape', async () => {
		const user = userEvent.setup();
		render(Toolbar, {
			hasActiveEditor: true,
			insertGroupWidthOverride: 80,
			onFormat: vi.fn(),
			onInsert: vi.fn()
		});

		await user.click(screen.getByRole('button', { name: 'More blocks' }));
		expect(screen.getByRole('listbox', { name: 'More blocks' })).toBeInTheDocument();

		await user.keyboard('{Escape}');
		expect(screen.queryByRole('listbox', { name: 'More blocks' })).not.toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'More blocks' }));
		expect(screen.getByRole('listbox', { name: 'More blocks' })).toBeInTheDocument();

		await user.click(document.body);
		expect(screen.queryByRole('listbox', { name: 'More blocks' })).not.toBeInTheDocument();
	});

	it('disables Undo/Redo by default and enables them per canUndo/canRedo', () => {
		render(Toolbar, { hasActiveEditor: false, onFormat: vi.fn(), onInsert: vi.fn() });
		expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
	});

	it('dispatches onUndo/onRedo when their buttons are enabled and clicked', async () => {
		const onUndo = vi.fn();
		const onRedo = vi.fn();
		const user = userEvent.setup();
		render(Toolbar, {
			hasActiveEditor: false,
			canUndo: true,
			canRedo: true,
			onFormat: vi.fn(),
			onInsert: vi.fn(),
			onUndo,
			onRedo
		});

		await user.click(screen.getByRole('button', { name: 'Undo' }));
		await user.click(screen.getByRole('button', { name: 'Redo' }));

		expect(onUndo).toHaveBeenCalledOnce();
		expect(onRedo).toHaveBeenCalledOnce();
	});

	it('gives every control in both groups the identical visual treatment', () => {
		render(Toolbar, { hasActiveEditor: true, onFormat: vi.fn(), onInsert: vi.fn() });

		const bold = screen.getByRole('button', { name: 'Bold' });
		const insertText = screen.getByRole('button', { name: 'Insert Text' });
		// Compare class lists ignoring the pressed-state classes, which only
		// apply conditionally to format controls.
		const normalize = (el: HTMLElement) =>
			el.className
				.split(' ')
				.filter((c) => c !== 'bg-accent' && c !== 'text-accent-fg')
				.sort((a, b) => a.localeCompare(b))
				.join(' ');
		expect(normalize(bold)).toBe(normalize(insertText));
	});
});
