import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import DocumentTitleInput from './DocumentTitleInput.svelte';

describe('DocumentTitleInput', () => {
	it('renders with initial title and placeholder', () => {
		render(DocumentTitleInput, {
			title: 'Initial Title',
			onNavigateNext: vi.fn()
		});

		const input = screen.getByPlaceholderText('Untitled document');
		expect(input).toHaveValue('Initial Title');
	});

	it('fires onTitleChange on typing', async () => {
		const onTitleChange = vi.fn();
		const user = userEvent.setup();

		render(DocumentTitleInput, {
			title: 'Old Title',
			onTitleChange,
			onNavigateNext: vi.fn()
		});

		const input = screen.getByDisplayValue('Old Title');
		await user.clear(input);
		await user.type(input, 'New Document Title');

		expect(onTitleChange).toHaveBeenCalled();
	});

	it('triggers onNavigateNext on Enter and ArrowDown', async () => {
		const onNavigateNext = vi.fn();
		const user = userEvent.setup();

		render(DocumentTitleInput, {
			title: 'Test',
			onNavigateNext
		});

		const input = screen.getByDisplayValue('Test');
		await user.type(input, '{Enter}');
		expect(onNavigateNext).toHaveBeenCalledTimes(1);

		await user.type(input, '{ArrowDown}');
		expect(onNavigateNext).toHaveBeenCalledTimes(2);
	});
});
