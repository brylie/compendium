import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import DocumentBreadcrumbs from './DocumentBreadcrumbs.svelte';

describe('DocumentBreadcrumbs', () => {
	it('renders workspace link, parent title, and current document title', () => {
		render(DocumentBreadcrumbs, {
			spaceId: 'space-1',
			parentDocTitle: 'Parent Page',
			title: 'Child Page',
			outlineOpen: false
		});

		expect(screen.getByText('Workspace')).toBeInTheDocument();
		expect(screen.getByText('Parent Page')).toBeInTheDocument();
		expect(screen.getByText('Child Page')).toBeInTheDocument();
	});

	it('renders fallback Untitled title when title is empty', () => {
		render(DocumentBreadcrumbs, {
			spaceId: 'space-1',
			title: '',
			outlineOpen: false
		});

		expect(screen.getByText('Untitled')).toBeInTheDocument();
	});

	it('toggles outlineOpen button aria attributes on click', async () => {
		const user = userEvent.setup();
		render(DocumentBreadcrumbs, {
			spaceId: 'space-1',
			title: 'Doc',
			outlineOpen: false
		});

		const toggleButton = screen.getByRole('button', { name: 'Open document List View' });
		expect(toggleButton).toHaveAttribute('aria-pressed', 'false');

		await user.click(toggleButton);
		expect(toggleButton).toHaveAttribute('aria-pressed', 'true');
		expect(toggleButton).toHaveAttribute('aria-label', 'Close document List View');
	});
});
