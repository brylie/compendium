import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import Sidebar from './Sidebar.svelte';

const { mockPageState } = vi.hoisted(() => ({
	mockPageState: { url: new URL('http://localhost/'), params: {} as Record<string, string> }
}));

vi.mock('$app/state', () => ({
	get page() {
		return mockPageState;
	}
}));

const goto = vi.hoisted(() => vi.fn());
const invalidateAll = vi.hoisted(() => vi.fn());
vi.mock('$app/navigation', () => ({ goto, invalidateAll }));

const isDark = vi.hoisted(() => vi.fn(() => false));
const toggleTheme = vi.hoisted(() => vi.fn(() => true));
vi.mock('$lib/client/theme', () => ({ isDark, toggleTheme }));

function setPath(path: string, params: Record<string, string> = {}): void {
	mockPageState.url = new URL(`http://localhost${path}`);
	mockPageState.params = params;
}

describe('Sidebar', () => {
	beforeEach(() => {
		setPath('/');
		goto.mockClear();
		invalidateAll.mockClear();
		isDark.mockClear();
		toggleTheme.mockClear();
		vi.stubGlobal(
			'localStorage',
			(() => {
				const store = new Map<string, string>();
				return {
					getItem: (k: string) => store.get(k) ?? null,
					setItem: (k: string, v: string) => {
						store.set(k, v);
					},
					removeItem: (k: string) => {
						store.delete(k);
					},
					clear: () => store.clear()
				};
			})()
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('renders the workspace logo and section headers expanded by default', () => {
		render(Sidebar, { activeSpaceId: 'space-1' });
		expect(screen.getByText('Compendium')).toBeInTheDocument();
		expect(screen.getByText('Documents')).toBeInTheDocument();
		expect(screen.getByText('Collections')).toBeInTheDocument();
	});

	it('shows empty-state copy when there are no documents or collections', () => {
		render(Sidebar, { activeSpaceId: 'space-1' });
		expect(screen.getByText('No documents yet')).toBeInTheDocument();
		expect(screen.getByText('No collections yet')).toBeInTheDocument();
	});

	it('collapses when the collapse button is clicked, and persists the choice', async () => {
		const user = userEvent.setup();
		render(Sidebar, { activeSpaceId: 'space-1' });
		await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
		expect(screen.queryByText('Compendium')).not.toBeInTheDocument();
		expect(localStorage.getItem('sidebar_collapsed')).toBe('true');
	});

	it('restores the collapsed state from localStorage on mount', () => {
		localStorage.setItem('sidebar_collapsed', 'true');
		render(Sidebar, { activeSpaceId: 'space-1' });
		expect(screen.queryByText('Compendium')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
	});

	it('lists documents from initialDocuments (catalog-backed, not derived from ydoc — #120)', () => {
		render(Sidebar, {
			activeSpaceId: 'space-1',
			initialDocuments: [{ id: 'doc-1', title: 'A Doc' } as never]
		});
		expect(screen.getByText('A Doc')).toBeInTheDocument();
	});

	it('falls back to the SSR snapshot before the Y.Doc has populated anything', () => {
		render(Sidebar, {
			activeSpaceId: 'space-1',
			initialDocuments: [{ id: 'ssr-doc', title: 'SSR Doc' } as never]
		});
		expect(screen.getByText('SSR Doc')).toBeInTheDocument();
	});

	it('renders nested sub-pages once the parent is expanded, and highlights the active document', async () => {
		setPath('/space/space-1/doc/child', { spaceId: 'space-1', id: 'child' });
		const user = userEvent.setup();
		render(Sidebar, {
			activeSpaceId: 'space-1',
			initialDocuments: [
				{ id: 'parent', title: 'Parent Doc', order: 'a0' } as never,
				{ id: 'child', title: 'Child Doc', parentDocumentId: 'parent', order: 'a0' } as never
			]
		});

		expect(screen.queryByText('Child Doc')).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Expand sub-pages' }));
		const childRow = screen.getByText('Child Doc').closest('a')!.parentElement!;
		expect(childRow).toHaveClass('text-accent');
	});

	it('lists collections and highlights the active one', () => {
		// Collections are catalog-backed only (#120), never derived from the live
		// ydoc — see Sidebar.svelte's `collections` derived.
		setPath('/space/space-1/table/col-1', { spaceId: 'space-1', id: 'col-1' });
		render(Sidebar, {
			activeSpaceId: 'space-1',
			initialCollections: [{ id: 'col-1', title: 'My Table', schema: [] } as never]
		});
		const link = screen.getByText('My Table').closest('a')!;
		expect(link).toHaveClass('text-accent');
	});

	it('creates a new document via the API and navigates to it', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				json: async () => ({ id: 'new-doc-id' })
			})
		);
		const user = userEvent.setup();
		render(Sidebar, { activeSpaceId: 'space-1' });

		await user.click(screen.getByRole('button', { name: 'New document' }));
		await user.type(screen.getByLabelText('Document title'), 'New Doc Title');
		await user.click(screen.getByRole('button', { name: 'Create' }));

		expect(fetch).toHaveBeenCalledWith(
			'/api/documents',
			expect.objectContaining({ method: 'POST' })
		);
		await vi.waitFor(() => expect(goto).toHaveBeenCalledWith('/space/space-1/doc/new-doc-id'));
	});

	it('does not create a document when creation is cancelled', async () => {
		vi.stubGlobal('fetch', vi.fn());
		const user = userEvent.setup();
		render(Sidebar, { activeSpaceId: 'space-1' });

		await user.click(screen.getByRole('button', { name: 'New document' }));
		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(fetch).not.toHaveBeenCalled();
	});

	it('shows an in-page error when document creation fails', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
		const user = userEvent.setup();
		render(Sidebar, { activeSpaceId: 'space-1' });

		await user.click(screen.getByRole('button', { name: 'New document' }));
		await user.type(screen.getByLabelText('Document title'), 'Title');
		await user.click(screen.getByRole('button', { name: 'Create' }));

		await vi.waitFor(() =>
			expect(screen.getByRole('alert')).toHaveTextContent('Failed to create document.')
		);
	});

	it('calls the delete API for a document after confirmation and navigates home if it was the active one', async () => {
		// Deletion is routed through the service layer via a DELETE call
		// (#120, a Document lives in its own shard) rather than a raw CRDT
		// write against ydoc — and since `documents` is catalog-backed only,
		// it won't disappear from this render until the parent's SSR data
		// refreshes; asserting the API call is what's actually observable here.
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
		setPath('/space/space-1/doc/doc-1', { spaceId: 'space-1', id: 'doc-1' });
		const user = userEvent.setup();
		render(Sidebar, {
			activeSpaceId: 'space-1',
			initialDocuments: [{ id: 'doc-1', title: 'To Delete' } as never]
		});

		await user.click(screen.getByRole('button', { name: 'Delete document' }));
		await user.click(screen.getByRole('button', { name: 'Delete' }));

		await vi.waitFor(() =>
			expect(fetch).toHaveBeenCalledWith('/api/documents/doc-1', { method: 'DELETE' })
		);
		await vi.waitFor(() => expect(goto).toHaveBeenCalledWith('/space/space-1'));
	});

	it('keeps the document when deletion is cancelled', async () => {
		const user = userEvent.setup();
		render(Sidebar, {
			activeSpaceId: 'space-1',
			initialDocuments: [{ id: 'doc-1', title: 'Keep Me' } as never]
		});

		await user.click(screen.getByRole('button', { name: 'Delete document' }));
		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.getByText('Keep Me')).toBeInTheDocument();
	});

	it('calls the delete API for a collection after confirmation', async () => {
		// Deletion is routed through the service layer via a DELETE call (#120,
		// a Collection lives in its own shard) rather than a raw CRDT write
		// against ydoc — and since `collections` is catalog-backed only, it
		// won't disappear from this render until the parent's SSR data
		// refreshes; asserting the API call is what's actually observable here.
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
		const user = userEvent.setup();
		render(Sidebar, {
			activeSpaceId: 'space-1',
			initialCollections: [{ id: 'col-1', title: 'Drop Table', schema: [] } as never]
		});

		await user.click(screen.getByRole('button', { name: 'Delete collection' }));
		await user.click(screen.getByRole('button', { name: 'Delete' }));

		await vi.waitFor(() =>
			expect(fetch).toHaveBeenCalledWith('/api/collections/col-1', { method: 'DELETE' })
		);
	});

	it('toggles dark mode via the footer button', async () => {
		const user = userEvent.setup();
		render(Sidebar, { activeSpaceId: 'space-1' });
		await user.click(screen.getByRole('button', { name: 'Toggle theme' }));
		expect(toggleTheme).toHaveBeenCalledOnce();
	});

	it('links to the tokens and audit settings pages', () => {
		render(Sidebar, { activeSpaceId: 'space-1' });
		const tokensLink = within(screen.getByLabelText('Workspace sidebar')).getByText('Tokens');
		const auditLink = within(screen.getByLabelText('Workspace sidebar')).getByText('Audit');
		expect(tokensLink.closest('a')).toHaveAttribute('href', '/settings/tokens');
		expect(auditLink.closest('a')).toHaveAttribute('href', '/audit');
	});
});
