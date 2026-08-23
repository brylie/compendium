import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import type { CollectionMeta, DocumentMeta } from '$lib/data/types';
import Page from './+page.svelte';

function doc(overrides: Partial<DocumentMeta>): DocumentMeta {
	return { id: overrides.id ?? 'd1', title: 'Untitled', order: 'a', recordIds: [], ...overrides };
}

function collection(overrides: Partial<CollectionMeta>): CollectionMeta {
	return { id: 'c1', title: 'Untitled', schema: [], recordIds: [], ...overrides };
}

describe('home +page', () => {
	it('shows empty-state copy when there are no documents or collections', () => {
		render(Page, {
			params: {},
			form: null,
			data: { documents: [], collections: [] }
		});
		expect(screen.getByText('No documents created yet.')).toBeInTheDocument();
		expect(screen.getByText('No collections created yet.')).toBeInTheDocument();
	});

	it('lists document and collection counts', () => {
		render(Page, {
			params: {},
			form: null,
			data: {
				documents: [doc({ id: 'a', title: 'A' }), doc({ id: 'b', title: 'B' })],
				collections: [collection({ id: 'c', title: 'C' })]
			}
		});
		expect(screen.getByText('2 total')).toBeInTheDocument();
		expect(screen.getByText('1 total')).toBeInTheDocument();
	});

	it('renders a nested document tree, indenting children under their parent', () => {
		render(Page, {
			params: {},
			form: null,
			data: {
				documents: [
					doc({ id: 'parent', title: 'Parent' }),
					doc({ id: 'child', title: 'Child', parentDocumentId: 'parent' })
				],
				collections: []
			}
		});
		const parentLink = screen.getByText('Parent').closest('a')!;
		const childLink = screen.getByText('Child').closest('a')!;
		expect(parentLink).toHaveAttribute('href', '/doc/parent');
		expect(childLink).toHaveAttribute('href', '/doc/child');
	});

	it('links each collection to its table view with a field count', () => {
		render(Page, {
			params: {},
			form: null,
			data: {
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
		expect(screen.getByText('Tasks').closest('a')).toHaveAttribute('href', '/table/c1');
		expect(screen.getByText('1 fields')).toBeInTheDocument();
	});

	it('submits new-document and new-collection forms to their respective actions', () => {
		render(Page, {
			params: {},
			form: null,
			data: { documents: [], collections: [] }
		});
		const forms = document.querySelectorAll('form');
		expect(forms[0]).toHaveAttribute('action', '?/createDocument');
		expect(forms[1]).toHaveAttribute('action', '?/createCollection');
	});
});
