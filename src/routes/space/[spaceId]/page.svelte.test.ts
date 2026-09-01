import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import type { CollectionMeta, DocumentMeta } from '$lib/data/types';
import Page from './+page.svelte';

vi.mock('$app/state', () => ({
	get page() {
		return { params: { spaceId: 'space-1' } };
	}
}));

function doc(overrides: Partial<DocumentMeta>): DocumentMeta {
	return { id: overrides.id ?? 'd1', title: 'Untitled', order: 'a', recordIds: [], ...overrides };
}

function collection(overrides: Partial<CollectionMeta>): CollectionMeta {
	return { id: 'c1', title: 'Untitled', schema: [], recordIds: [], ...overrides };
}

describe('home +page', () => {
	it('shows empty-state copy when there are no documents or collections', () => {
		render(Page, {
			params: { spaceId: 'space-1' },
			form: null,
			data: {
				spaces: [],
				spaceId: 'space-1',
				activeSpaceId: 'space-1',
				documents: [],
				collections: []
			}
		});
		expect(screen.getByText('No documents created yet.')).toBeInTheDocument();
		expect(screen.getByText('No collections created yet.')).toBeInTheDocument();
	});

	it('lists document and collection counts', () => {
		render(Page, {
			params: { spaceId: 'space-1' },
			form: null,
			data: {
				spaces: [],
				spaceId: 'space-1',
				activeSpaceId: 'space-1',
				documents: [doc({ id: 'a', title: 'A' }), doc({ id: 'b', title: 'B' })],
				collections: [collection({ id: 'c', title: 'C' })]
			}
		});
		expect(screen.getByText('2 total')).toBeInTheDocument();
		expect(screen.getByText('1 total')).toBeInTheDocument();
	});

	it('renders a nested document tree, indenting children under their parent', () => {
		render(Page, {
			params: { spaceId: 'space-1' },
			form: null,
			data: {
				spaces: [],
				spaceId: 'space-1',
				activeSpaceId: 'space-1',
				documents: [
					doc({ id: 'parent', title: 'Parent' }),
					doc({ id: 'child', title: 'Child', parentDocumentId: 'parent' })
				],
				collections: []
			}
		});
		const parentLink = screen.getByText('Parent').closest('a')!;
		const childLink = screen.getByText('Child').closest('a')!;
		expect(parentLink).toHaveAttribute('href', '/space/space-1/doc/parent');
		expect(childLink).toHaveAttribute('href', '/space/space-1/doc/child');
	});

	it('links each collection to its table view with a field count', () => {
		render(Page, {
			params: { spaceId: 'space-1' },
			form: null,
			data: {
				spaces: [],
				spaceId: 'space-1',
				activeSpaceId: 'space-1',
				documents: [],
				collections: [
					collection({
						id: 'c1',
						title: 'Tasks',
						schema: [{ key: 'k', label: 'Status', type: 'text' }]
					})
				]
			}
		});
		expect(screen.getByText('Tasks').closest('a')).toHaveAttribute(
			'href',
			'/space/space-1/table/c1'
		);
		expect(screen.getByText('1 fields')).toBeInTheDocument();
	});

	it('submits new-document and new-collection forms to their respective actions', () => {
		render(Page, {
			params: { spaceId: 'space-1' },
			form: null,
			data: {
				spaces: [],
				spaceId: 'space-1',
				activeSpaceId: 'space-1',
				documents: [],
				collections: []
			}
		});
		const forms = document.querySelectorAll('form');
		expect(forms[0]).toHaveAttribute('action', '?/createDocument');
		expect(forms[1]).toHaveAttribute('action', '?/createCollection');
	});
});
