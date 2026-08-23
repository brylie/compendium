import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import SlashMenu from './SlashMenu.svelte';

describe('SlashMenu', () => {
	it('lists every basic block command when the query is empty', () => {
		render(SlashMenu, { query: '', onSelect: vi.fn() });
		expect(screen.getAllByRole('option')).toHaveLength(16);
	});

	it('filters commands by label', () => {
		render(SlashMenu, { query: 'heading 1', onSelect: vi.fn() });
		const options = screen.getAllByRole('option');
		expect(options).toHaveLength(1);
		expect(options[0]).toHaveTextContent('Heading 1');
	});

	it('filters commands by keyword even when the keyword is not in the label', () => {
		render(SlashMenu, { query: 'ul', onSelect: vi.fn() });
		expect(screen.getByText('Bulleted list')).toBeInTheDocument();
	});

	it('shows a "no matching commands" message when nothing matches', () => {
		render(SlashMenu, { query: 'zzzznotacommand', onSelect: vi.fn() });
		expect(screen.queryAllByRole('option')).toHaveLength(0);
		expect(screen.getByText('No matching commands')).toBeInTheDocument();
	});

	it('marks the first command as selected by default', () => {
		render(SlashMenu, { query: '', onSelect: vi.fn() });
		const options = screen.getAllByRole('option');
		expect(options[0]).toHaveAttribute('aria-selected', 'true');
		expect(options[1]).toHaveAttribute('aria-selected', 'false');
	});

	it('calls onSelect with the block type when a command is clicked', async () => {
		const onSelect = vi.fn();
		const user = userEvent.setup();
		render(SlashMenu, { query: 'heading 1', onSelect });
		await user.click(screen.getByText('Heading 1'));
		expect(onSelect).toHaveBeenCalledWith('heading_1');
	});

	it('moves the selection on hover', async () => {
		const user = userEvent.setup();
		render(SlashMenu, { query: 'heading', onSelect: vi.fn() });
		const options = screen.getAllByRole('option');
		await user.hover(options[2]);
		expect(options[2]).toHaveAttribute('aria-selected', 'true');
		expect(options[0]).toHaveAttribute('aria-selected', 'false');
	});

	it('moves the selection down and up with arrow keys, wrapping at the ends', async () => {
		const user = userEvent.setup();
		render(SlashMenu, { query: 'heading', onSelect: vi.fn() });
		let options = screen.getAllByRole('option');
		expect(options[0]).toHaveAttribute('aria-selected', 'true');

		await user.keyboard('{ArrowUp}');
		options = screen.getAllByRole('option');
		expect(options.at(-1)).toHaveAttribute('aria-selected', 'true');

		await user.keyboard('{ArrowDown}');
		options = screen.getAllByRole('option');
		expect(options[0]).toHaveAttribute('aria-selected', 'true');
	});

	it('selects the highlighted command on Enter', async () => {
		const onSelect = vi.fn();
		const user = userEvent.setup();
		render(SlashMenu, { query: 'heading', onSelect });
		await user.keyboard('{ArrowDown}{Enter}');
		expect(onSelect).toHaveBeenCalledWith('heading_2');
	});

	it('calls onClose on Escape', async () => {
		const onClose = vi.fn();
		const user = userEvent.setup();
		render(SlashMenu, { query: '', onSelect: vi.fn(), onClose });
		await user.keyboard('{Escape}');
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('does not throw on Escape when onClose is not provided', async () => {
		const user = userEvent.setup();
		render(SlashMenu, { query: '', onSelect: vi.fn() });
		await expect(user.keyboard('{Escape}')).resolves.toBeUndefined();
	});

	it('removes its window keydown listener on unmount', async () => {
		const onSelect = vi.fn();
		const user = userEvent.setup();
		const { unmount } = render(SlashMenu, { query: '', onSelect });
		unmount();
		await user.keyboard('{Enter}');
		expect(onSelect).not.toHaveBeenCalled();
	});
});
