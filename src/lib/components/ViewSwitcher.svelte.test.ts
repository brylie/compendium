import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import ViewSwitcher from './ViewSwitcher.svelte';

describe('ViewSwitcher', () => {
	it('renders links to all three views for the given collection', () => {
		render(ViewSwitcher, { collectionId: 'col-1', active: 'table' });

		expect(screen.getByRole('link', { name: /Table/ })).toHaveAttribute('href', '/table/col-1');
		expect(screen.getByRole('link', { name: /Board/ })).toHaveAttribute('href', '/board/col-1');
		expect(screen.getByRole('link', { name: /Calendar/ })).toHaveAttribute(
			'href',
			'/calendar/col-1'
		);
	});

	it('marks the active view with aria-current', () => {
		render(ViewSwitcher, { collectionId: 'col-1', active: 'board' });

		expect(screen.getByRole('link', { name: /Board/ })).toHaveAttribute('aria-current', 'page');
		expect(screen.getByRole('link', { name: /Table/ })).not.toHaveAttribute('aria-current');
		expect(screen.getByRole('link', { name: /Calendar/ })).not.toHaveAttribute('aria-current');
	});
});
