import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import SpaceSwitcher from './SpaceSwitcher.svelte';

const goto = vi.hoisted(() => vi.fn());
vi.mock('$app/navigation', () => ({ goto }));

const SPACES = [
	{ id: 'space-a', workspaceId: 'default', name: 'Default' },
	{ id: 'space-b', workspaceId: 'default', name: 'Second Space' }
];

describe('SpaceSwitcher', () => {
	beforeEach(() => {
		goto.mockClear();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('shows the active space name on the trigger and marks it in the menu', async () => {
		const user = userEvent.setup();
		render(SpaceSwitcher, { spaces: SPACES, activeSpaceId: 'space-a' });

		expect(screen.getByRole('button', { name: 'Switch space' })).toHaveTextContent('Default');

		await user.click(screen.getByRole('button', { name: 'Switch space' }));
		const activeItem = screen.getByRole('menuitem', { name: /Default/ });
		expect(activeItem).toHaveClass('text-accent');
	});

	it('navigates to the clicked space', async () => {
		const user = userEvent.setup();
		render(SpaceSwitcher, { spaces: SPACES, activeSpaceId: 'space-a' });

		await user.click(screen.getByRole('button', { name: 'Switch space' }));
		await user.click(screen.getByRole('menuitem', { name: /Second Space/ }));

		expect(goto).toHaveBeenCalledWith('/space/space-b');
	});

	it('keeps the "New space" dialog open and shows the error inline when creation fails (#140 regression)', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
		const user = userEvent.setup();
		render(SpaceSwitcher, { spaces: SPACES, activeSpaceId: 'space-a' });

		await user.click(screen.getByRole('button', { name: 'Switch space' }));
		await user.click(screen.getByRole('menuitem', { name: 'New space' }));
		await user.type(screen.getByLabelText('Space name'), 'Broken Space');
		await user.click(screen.getByRole('button', { name: 'Create' }));

		// The dialog (not the already-closed dropdown panel) is what stays open
		// and shows the failure — before the fix, errorMessage was only ever
		// rendered inside the dropdown, which had already closed by this point.
		await vi.waitFor(() =>
			expect(screen.getByRole('alert')).toHaveTextContent('Failed to create space.')
		);
		expect(screen.getByLabelText('Space name')).toBeInTheDocument();
		expect(goto).not.toHaveBeenCalled();
	});

	it('creates a space and navigates to it on success', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'new-space-id' }) })
		);
		const user = userEvent.setup();
		render(SpaceSwitcher, { spaces: SPACES, activeSpaceId: 'space-a' });

		await user.click(screen.getByRole('button', { name: 'Switch space' }));
		await user.click(screen.getByRole('menuitem', { name: 'New space' }));
		await user.type(screen.getByLabelText('Space name'), 'New Space');
		await user.click(screen.getByRole('button', { name: 'Create' }));

		await vi.waitFor(() => expect(goto).toHaveBeenCalledWith('/space/new-space-id'));
	});

	it('renders a compact icon-only trigger when collapsed', () => {
		render(SpaceSwitcher, { spaces: SPACES, activeSpaceId: 'space-a', collapsed: true });
		// Accessible name must include the active Space, not just the generic
		// "Switch space" label — aria-label wins over `title` in accessible-name
		// computation, so a screen reader would otherwise never announce which
		// Space is currently active on this icon-only trigger.
		const trigger = screen.getByRole('button', { name: 'Switch space (current: Default)' });
		expect(trigger).toHaveAttribute('title', 'Default');
		expect(trigger).not.toHaveTextContent('Default');
	});

	it('toggles the menu open and closed via the expanded trigger', async () => {
		const user = userEvent.setup();
		render(SpaceSwitcher, { spaces: SPACES, activeSpaceId: 'space-a' });

		const trigger = screen.getByRole('button', { name: 'Switch space' });
		await user.click(trigger);
		expect(screen.getByRole('menu')).toBeInTheDocument();

		await user.click(trigger);
		expect(screen.queryByRole('menu')).toBeNull();
	});

	it('toggles the menu open and closed via the collapsed trigger', async () => {
		const user = userEvent.setup();
		render(SpaceSwitcher, { spaces: SPACES, activeSpaceId: 'space-a', collapsed: true });

		const trigger = screen.getByRole('button', { name: 'Switch space (current: Default)' });
		await user.click(trigger);
		expect(screen.getByRole('menu')).toBeInTheDocument();

		await user.click(trigger);
		expect(screen.queryByRole('menu')).toBeNull();
	});

	it('closes without navigating when the already-active space is clicked', async () => {
		const user = userEvent.setup();
		render(SpaceSwitcher, { spaces: SPACES, activeSpaceId: 'space-a' });

		await user.click(screen.getByRole('button', { name: 'Switch space' }));
		await user.click(screen.getByRole('menuitem', { name: /Default/ }));

		expect(goto).not.toHaveBeenCalled();
		expect(screen.queryByRole('menu')).toBeNull();
	});

	it('defaults a blank space name to "Untitled Space"', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'new-space-id' }) })
		);
		const user = userEvent.setup();
		render(SpaceSwitcher, { spaces: SPACES, activeSpaceId: 'space-a' });

		await user.click(screen.getByRole('button', { name: 'Switch space' }));
		await user.click(screen.getByRole('menuitem', { name: 'New space' }));
		await user.click(screen.getByRole('button', { name: 'Create' }));

		await vi.waitFor(() => expect(goto).toHaveBeenCalledWith('/space/new-space-id'));
		expect(globalThis.fetch).toHaveBeenCalledWith(
			'/api/spaces',
			expect.objectContaining({ body: JSON.stringify({ name: 'Untitled Space' }) })
		);
	});

	it('closes the menu on an outside click, and stays open on an inside click', async () => {
		const user = userEvent.setup();
		render(SpaceSwitcher, { spaces: SPACES, activeSpaceId: 'space-a' });

		await user.click(screen.getByRole('button', { name: 'Switch space' }));
		expect(screen.getByRole('menu')).toBeInTheDocument();

		// Inside click — on the menu's own border divider, not an item — must
		// not close the menu.
		await user.click(document.querySelector('[role="menu"] > div')!);
		expect(screen.getByRole('menu')).toBeInTheDocument();

		await user.click(document.body);
		expect(screen.queryByRole('menu')).toBeNull();
	});

	describe('keyboard navigation in the open menu', () => {
		it('closes the menu on Escape and returns focus to the trigger', async () => {
			const user = userEvent.setup();
			render(SpaceSwitcher, { spaces: SPACES, activeSpaceId: 'space-a' });

			const trigger = screen.getByRole('button', { name: 'Switch space' });
			await user.click(trigger);
			await vi.waitFor(() =>
				expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0])
			);
			await user.keyboard('{Escape}');

			expect(screen.queryByRole('menu')).toBeNull();
			expect(document.activeElement).toBe(trigger);
		});

		it('moves focus forward with ArrowDown and wraps at the end', async () => {
			const user = userEvent.setup();
			render(SpaceSwitcher, { spaces: SPACES, activeSpaceId: 'space-a' });

			await user.click(screen.getByRole('button', { name: 'Switch space' }));
			const items = screen.getAllByRole('menuitem');
			await vi.waitFor(() => expect(document.activeElement).toBe(items[0]));

			await user.keyboard('{ArrowDown}');
			expect(document.activeElement).toBe(items[1]);
			await user.keyboard('{ArrowDown}');
			expect(document.activeElement).toBe(items[2]);
			await user.keyboard('{ArrowDown}');
			expect(document.activeElement).toBe(items[0]);
		});

		it('moves focus backward with ArrowUp and wraps at the start', async () => {
			const user = userEvent.setup();
			render(SpaceSwitcher, { spaces: SPACES, activeSpaceId: 'space-a' });

			await user.click(screen.getByRole('button', { name: 'Switch space' }));
			const items = screen.getAllByRole('menuitem');
			await vi.waitFor(() => expect(document.activeElement).toBe(items[0]));

			await user.keyboard('{ArrowUp}');
			expect(document.activeElement).toBe(items[items.length - 1]);
		});
	});
});
