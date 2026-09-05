import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { CollectionMeta, DocumentMeta } from '$lib/data/types';
import Page from './+page.svelte';

interface TestToken {
	tokenHash: string;
	clientLabel: string;
	allowedDocumentIds: string[];
	allowedCollectionIds: string[];
	allowedSpaceIds: string[];
	createdAt: number;
	revokedAt?: number;
}

function token(overrides: Partial<TestToken> = {}): TestToken {
	return {
		tokenHash: 'hash-1',
		clientLabel: 'Claude Desktop',
		allowedDocumentIds: [],
		allowedCollectionIds: [],
		allowedSpaceIds: [],
		createdAt: Date.UTC(2026, 0, 1),
		...overrides
	};
}

function doc(id: string, title: string): DocumentMeta {
	return { id, title, order: 'a', recordIds: [] };
}

function collection(id: string, title: string): CollectionMeta {
	return { id, title, schema: [], recordIds: [] };
}

describe('settings/tokens +page', () => {
	it('shows an empty-state row when there are no tokens', () => {
		render(Page, {
			params: {},
			data: { spaces: [], activeSpaceId: 'space-1', tokens: [], documents: [], collections: [] },
			form: null
		});
		expect(screen.getByText('No access tokens created yet.')).toBeInTheDocument();
	});

	it('lists a token with its scope summary and Active status', () => {
		render(Page, {
			params: {},
			data: {
				spaces: [],
				activeSpaceId: 'space-1',
				tokens: [token({ allowedDocumentIds: ['d1', 'd2'], allowedCollectionIds: ['c1'] })],
				documents: [],
				collections: []
			},
			form: null
		});
		expect(screen.getByText('Claude Desktop')).toBeInTheDocument();
		expect(screen.getByText('2 doc(s), 1 collection(s)')).toBeInTheDocument();
		expect(screen.getByText('Active')).toBeInTheDocument();
	});

	it('shows Revoked status and hides the revoke button for a revoked token', () => {
		render(Page, {
			params: {},
			data: {
				spaces: [],
				activeSpaceId: 'space-1',
				tokens: [token({ revokedAt: Date.now() })],
				documents: [],
				collections: []
			},
			form: null
		});
		expect(screen.getByText('Revoked')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
	});

	it('shows a revoke button submitting the tokenHash for an active token', () => {
		render(Page, {
			params: {},
			data: {
				spaces: [],
				activeSpaceId: 'space-1',
				tokens: [token({ tokenHash: 'abc123' })],
				documents: [],
				collections: []
			},
			form: null
		});
		const button = screen.getByRole('button', { name: 'Revoke' });
		const form = button.closest('form')!;
		expect(form).toHaveAttribute('action', '?/revoke');
		expect(form.querySelector('input[name="tokenHash"]')).toHaveValue('abc123');
	});

	it('shows the freshly-created token banner once, from action data', () => {
		render(Page, {
			params: {},
			data: { spaces: [], activeSpaceId: 'space-1', tokens: [], documents: [], collections: [] },
			form: { createdToken: 'secret-token-value', clientLabel: 'Cursor' }
		});
		expect(screen.getByText('secret-token-value')).toBeInTheDocument();
		expect(screen.getByText(/Token created for "Cursor"/)).toBeInTheDocument();
	});

	it('does not show the banner when there is no form result', () => {
		render(Page, {
			params: {},
			data: { spaces: [], activeSpaceId: 'space-1', tokens: [], documents: [], collections: [] },
			form: null
		});
		expect(screen.queryByText(/copy it now/)).not.toBeInTheDocument();
	});

	it('lists selectable documents and collections for scoping a new token', () => {
		render(Page, {
			params: {},
			data: {
				spaces: [],
				activeSpaceId: 'space-1',
				tokens: [],
				documents: [doc('d1', 'Design Notes')],
				collections: []
			},
			form: null
		});
		const checkbox = screen.getByText('Design Notes').closest('label')!.querySelector('input')!;
		expect(checkbox).toHaveAttribute('name', 'documentIds');
		expect(checkbox).toHaveAttribute('value', 'd1');
	});

	it('includes the space count in the scope summary when a token has Space grants', () => {
		render(Page, {
			params: {},
			data: {
				spaces: [],
				activeSpaceId: 'space-1',
				tokens: [token({ allowedSpaceIds: ['space-a', 'space-b'] })],
				documents: [],
				collections: []
			},
			form: null
		});
		expect(screen.getByText('0 doc(s), 0 collection(s), 2 space(s)')).toBeInTheDocument();
	});

	it('lists selectable collections for scoping a new token', () => {
		render(Page, {
			params: {},
			data: {
				spaces: [],
				activeSpaceId: 'space-1',
				tokens: [],
				documents: [],
				collections: [collection('c1', 'Sprint Tasks')]
			},
			form: null
		});
		const checkbox = screen.getByText('Sprint Tasks').closest('label')!.querySelector('input')!;
		expect(checkbox).toHaveAttribute('name', 'collectionIds');
		expect(checkbox).toHaveAttribute('value', 'c1');
	});

	it('falls back to "Untitled" for a document or collection with a blank title', () => {
		render(Page, {
			params: {},
			data: {
				spaces: [],
				activeSpaceId: 'space-1',
				tokens: [],
				documents: [doc('d1', '')],
				collections: [collection('c1', '')]
			},
			form: null
		});
		expect(screen.getAllByText('Untitled')).toHaveLength(2);
	});

	it('lists selectable spaces for scoping a new token', () => {
		render(Page, {
			params: {},
			data: {
				spaces: [{ id: 'space-a', workspaceId: 'default', name: 'Marketing' }],
				activeSpaceId: 'space-1',
				tokens: [],
				documents: [],
				collections: []
			},
			form: null
		});
		const checkbox = screen.getByText('Marketing').closest('label')!.querySelector('input')!;
		expect(checkbox).toHaveAttribute('name', 'spaceIds');
		expect(checkbox).toHaveAttribute('value', 'space-a');
	});

	it("groups the Allowed Documents picker by Space (issue #78: a bare flat list can't tell two same-titled Documents in different Spaces apart)", () => {
		render(Page, {
			params: {},
			data: {
				spaces: [
					{ id: 'space-a', workspaceId: 'default', name: 'Marketing' },
					{ id: 'space-b', workspaceId: 'default', name: 'Engineering' }
				],
				activeSpaceId: 'space-1',
				tokens: [],
				documents: [
					{ id: 'doc-a', title: 'Team Page', order: 'a', recordIds: [], spaceId: 'space-a' },
					{ id: 'doc-b', title: 'Team Page', order: 'a', recordIds: [], spaceId: 'space-b' }
				],
				collections: []
			},
			form: null
		});
		// "Marketing"/"Engineering" each appear twice: once as an Allowed Spaces
		// checkbox label, once as the Allowed Documents group heading.
		expect(screen.getAllByText('Marketing')).toHaveLength(2);
		expect(screen.getAllByText('Engineering')).toHaveLength(2);
		expect(screen.getAllByText('Team Page')).toHaveLength(2);
	});

	it('groups documents with no known Space under an "Uncataloged" heading', () => {
		render(Page, {
			params: {},
			data: {
				spaces: [],
				activeSpaceId: 'space-1',
				tokens: [],
				documents: [doc('d1', 'Legacy Page')],
				collections: []
			},
			form: null
		});
		expect(screen.getByText('Uncataloged')).toBeInTheDocument();
		expect(screen.getByText('Legacy Page')).toBeInTheDocument();
	});

	it('renders a child Document collapsed by default, then reveals it on expand', async () => {
		const user = userEvent.setup();
		render(Page, {
			params: {},
			data: {
				spaces: [{ id: 'space-a', workspaceId: 'default', name: 'Marketing' }],
				activeSpaceId: 'space-1',
				tokens: [],
				documents: [
					{ id: 'parent', title: 'Parent Page', order: 'a0', recordIds: [], spaceId: 'space-a' },
					{
						id: 'child',
						title: 'Child Page',
						order: 'a0',
						recordIds: [],
						parentDocumentId: 'parent',
						spaceId: 'space-a'
					}
				],
				collections: []
			},
			form: null
		});
		expect(screen.queryByText('Child Page')).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Expand sub-pages' }));
		expect(screen.getByText('Child Page')).toBeInTheDocument();
	});

	it('checks a page and all its current sub-pages when "select this page and its sub-pages" is clicked', async () => {
		const user = userEvent.setup();
		render(Page, {
			params: {},
			data: {
				spaces: [{ id: 'space-a', workspaceId: 'default', name: 'Marketing' }],
				activeSpaceId: 'space-1',
				tokens: [],
				documents: [
					{ id: 'parent', title: 'Parent Page', order: 'a0', recordIds: [], spaceId: 'space-a' },
					{
						id: 'child',
						title: 'Child Page',
						order: 'a0',
						recordIds: [],
						parentDocumentId: 'parent',
						spaceId: 'space-a'
					}
				],
				collections: []
			},
			form: null
		});
		await user.click(screen.getByRole('button', { name: 'Select this page and its sub-pages' }));
		const parentCheckbox = screen
			.getByText('Parent Page')
			.closest('label')!
			.querySelector('input')!;
		expect(parentCheckbox).toBeChecked();
		await user.click(screen.getByRole('button', { name: 'Expand sub-pages' }));
		const childCheckbox = screen.getByText('Child Page').closest('label')!.querySelector('input')!;
		expect(childCheckbox).toBeChecked();
	});

	it('submits the connect-client form to the create action', () => {
		render(Page, {
			params: {},
			data: { spaces: [], activeSpaceId: 'space-1', tokens: [], documents: [], collections: [] },
			form: null
		});
		const form = screen.getByLabelText('Client Label').closest('form')!;
		expect(form).toHaveAttribute('action', '?/create');
	});
});
