import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import BlockActionMenu from './BlockActionMenu.svelte';

const CONVERT_OPTIONS = [
	{ type: 'paragraph' as const, label: 'Text' },
	{ type: 'heading_1' as const, label: 'Heading 1' },
	{ type: 'bulleted_list_item' as const, label: 'Bulleted list' }
];

function baseProps() {
	return {
		blockType: 'paragraph' as const,
		canMoveUp: true,
		canMoveDown: true,
		isConvertible: true,
		convertOptions: CONVERT_OPTIONS,
		onDuplicate: vi.fn(),
		onDelete: vi.fn(),
		onConvert: vi.fn(),
		onCopyLink: vi.fn(),
		onMoveUp: vi.fn(),
		onMoveDown: vi.fn()
	};
}

describe('BlockActionMenu (#152)', () => {
	it('opens the menu from its trigger and lists every action', async () => {
		const user = userEvent.setup();
		render(BlockActionMenu, baseProps());

		await user.click(screen.getByRole('button', { name: 'Block actions' }));

		expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBeInTheDocument();
		expect(screen.getByRole('menuitem', { name: 'Convert to…' })).toBeInTheDocument();
		expect(screen.getByRole('menuitem', { name: 'Copy link to block' })).toBeInTheDocument();
		expect(screen.getByRole('menuitem', { name: 'Move up' })).toBeInTheDocument();
		expect(screen.getByRole('menuitem', { name: 'Move down' })).toBeInTheDocument();
		expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
	});

	it('calls onDuplicate and closes the menu', async () => {
		const user = userEvent.setup();
		const props = baseProps();
		render(BlockActionMenu, props);

		await user.click(screen.getByRole('button', { name: 'Block actions' }));
		await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));

		expect(props.onDuplicate).toHaveBeenCalledOnce();
		expect(screen.queryByRole('menuitem', { name: 'Duplicate' })).not.toBeInTheDocument();
	});

	it('calls onDelete', async () => {
		const user = userEvent.setup();
		const props = baseProps();
		render(BlockActionMenu, props);

		await user.click(screen.getByRole('button', { name: 'Block actions' }));
		await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

		expect(props.onDelete).toHaveBeenCalledOnce();
	});

	it('calls onCopyLink', async () => {
		const user = userEvent.setup();
		const props = baseProps();
		render(BlockActionMenu, props);

		await user.click(screen.getByRole('button', { name: 'Block actions' }));
		await user.click(screen.getByRole('menuitem', { name: 'Copy link to block' }));

		expect(props.onCopyLink).toHaveBeenCalledOnce();
	});

	it('calls onMoveUp and onMoveDown when enabled', async () => {
		const user = userEvent.setup();
		const props = baseProps();
		render(BlockActionMenu, props);

		await user.click(screen.getByRole('button', { name: 'Block actions' }));
		await user.click(screen.getByRole('menuitem', { name: 'Move up' }));
		expect(props.onMoveUp).toHaveBeenCalledOnce();

		await user.click(screen.getByRole('button', { name: 'Block actions' }));
		await user.click(screen.getByRole('menuitem', { name: 'Move down' }));
		expect(props.onMoveDown).toHaveBeenCalledOnce();
	});

	it('ArrowDown/ArrowUp move roving focus among the menu items, wrapping at each end', async () => {
		const user = userEvent.setup();
		render(BlockActionMenu, baseProps());

		await user.click(screen.getByRole('button', { name: 'Block actions' }));
		const duplicate = screen.getByRole('menuitem', { name: 'Duplicate' });
		expect(duplicate).toHaveFocus();

		await user.keyboard('{ArrowUp}');
		expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus();

		await user.keyboard('{ArrowDown}');
		expect(duplicate).toHaveFocus();
	});

	it('disables Move up/down at the respective ends and does not invoke the callback', async () => {
		const user = userEvent.setup();
		const props = { ...baseProps(), canMoveUp: false, canMoveDown: false };
		render(BlockActionMenu, props);

		await user.click(screen.getByRole('button', { name: 'Block actions' }));
		const up = screen.getByRole('menuitem', { name: 'Move up' });
		const down = screen.getByRole('menuitem', { name: 'Move down' });
		expect(up).toBeDisabled();
		expect(down).toBeDisabled();

		await user.click(up);
		await user.click(down);
		expect(props.onMoveUp).not.toHaveBeenCalled();
		expect(props.onMoveDown).not.toHaveBeenCalled();
	});

	it('does not offer "Convert to…" when isConvertible is false', async () => {
		const user = userEvent.setup();
		render(BlockActionMenu, { ...baseProps(), isConvertible: false });

		await user.click(screen.getByRole('button', { name: 'Block actions' }));

		expect(screen.queryByRole('menuitem', { name: 'Convert to…' })).not.toBeInTheDocument();
	});

	it('drills into the convert submenu, calls onConvert with the chosen type, and marks the current type', async () => {
		const user = userEvent.setup();
		const props = baseProps();
		render(BlockActionMenu, props);

		await user.click(screen.getByRole('button', { name: 'Block actions' }));
		await user.click(screen.getByRole('menuitem', { name: 'Convert to…' }));

		const currentTypeItem = screen.getByRole('menuitem', { name: 'Text' });
		expect(currentTypeItem).toBeDisabled();

		await user.click(screen.getByRole('menuitem', { name: 'Heading 1' }));

		expect(props.onConvert).toHaveBeenCalledWith('heading_1');
		expect(screen.queryByRole('menuitem', { name: 'Back' })).not.toBeInTheDocument();
	});

	it('Back returns from the convert submenu to the main menu', async () => {
		const user = userEvent.setup();
		render(BlockActionMenu, baseProps());

		await user.click(screen.getByRole('button', { name: 'Block actions' }));
		await user.click(screen.getByRole('menuitem', { name: 'Convert to…' }));
		await user.click(screen.getByRole('menuitem', { name: 'Back' }));

		expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBeInTheDocument();
	});

	it('closes on Escape from the main menu, and returns to the main menu (without closing) on Escape from the submenu', async () => {
		const user = userEvent.setup();
		render(BlockActionMenu, baseProps());

		await user.click(screen.getByRole('button', { name: 'Block actions' }));
		await user.click(screen.getByRole('menuitem', { name: 'Convert to…' }));
		await user.keyboard('{Escape}');
		expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBeInTheDocument();

		await user.keyboard('{Escape}');
		expect(screen.queryByRole('menuitem', { name: 'Duplicate' })).not.toBeInTheDocument();
	});

	it('closes when clicking outside the menu', async () => {
		const user = userEvent.setup();
		render(BlockActionMenu, baseProps());

		await user.click(screen.getByRole('button', { name: 'Block actions' }));
		expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBeInTheDocument();

		await user.click(document.body);
		expect(screen.queryByRole('menuitem', { name: 'Duplicate' })).not.toBeInTheDocument();
	});
});
