import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import { createDocument, createCollection } from '$lib/data/records';
import Sidebar from './Sidebar.svelte';

const { mockPageState } = vi.hoisted(() => ({
	mockPageState: { url: new URL('http://localhost/') }
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

let ydoc: Y.Doc;
vi.mock('$lib/client/yjs-client', () => ({
	getClientDoc: () => ydoc
}));

function setPath(path: string): void {
	mockPageState.url = new URL(`http://localhost${path}`);
}

describe('Sidebar', () => {
	beforeEach(() => {
		ydoc = new Y.Doc();
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
					setItem: (k: string, v: string) => void store.set(k, v),
					removeItem: (k: string) => void store.delete(k),
					clear: () => store.clear()
				};
			})()
		);
	});

	afterEach(() => {
		ydoc.destroy();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('renders the workspace logo and section headers expanded by default', () => {
		render(Sidebar, {});
		expect(screen.getByText('Compendium')).toBeInTheDocument();
		expect(screen.getByText('Documents')).toBeInTheDocument();
		expect(screen.getByText('Collections')).toBeInTheDocument();
	});

	it('shows empty-state copy when there are no documents or collections', () => {
		render(Sidebar, {});
		expect(screen.getByText('No documents yet')).toBeInTheDocument();
		expect(screen.getByText('No collections yet')).toBeInTheDocument();
	});

	it('collapses when the collapse button is clicked, and persists the choice', async () => {
		const user = userEvent.setup();
		render(Sidebar, {});
		await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
		expect(screen.queryByText('Compendium')).not.toBeInTheDocument();
		expect(localStorage.getItem('sidebar_collapsed')).toBe('true');
	});

	it('restores the collapsed state from localStorage on mount', () => {
		localStorage.setItem('sidebar_collapsed', 'true');
		render(Sidebar, {});
		expect(screen.queryByText('Compendium')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
	});

	it('lists documents from the live Y.Doc, preferring them over the SSR snapshot', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'Live Doc' });
		render(Sidebar, { initialDocuments: [{ id: 'stale', title: 'Stale SSR Doc' } as never] });
		expect(screen.getByText('Live Doc')).toBeInTheDocument();
		expect(screen.queryByText('Stale SSR Doc')).not.toBeInTheDocument();
	});

	it('falls back to the SSR snapshot before the Y.Doc has populated anything', () => {
		render(Sidebar, {
			initialDocuments: [{ id: 'ssr-doc', title: 'SSR Doc' } as never]
		});
		expect(screen.getByText('SSR Doc')).toBeInTheDocument();
	});

	it('renders nested sub-pages once the parent is expanded, and highlights the active document', async () => {
		createDocument(ydoc, { id: 'parent', title: 'Parent Doc' });
		createDocument(ydoc, { id: 'child', title: 'Child Doc', parentDocumentId: 'parent' });
		setPath('/doc/child');
		const user = userEvent.setup();
		render(Sidebar, {});

		expect(screen.queryByText('Child Doc')).not.toBeInTheDocument();
		await user.click(screen.getByRole('button', { name: 'Expand sub-pages' }));
		const childRow = screen.getByText('Child Doc').closest('a')!.parentElement!;
		expect(childRow).toHaveClass('text-accent');
	});

	it('lists collections and highlights the active one', () => {
		createCollection(ydoc, { id: 'col-1', title: 'My Table', schema: [] });
		setPath('/table/col-1');
		render(Sidebar, {});
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
		render(Sidebar, {});

		await user.click(screen.getByRole('button', { name: 'New document' }));
		await user.type(screen.getByLabelText('Document title'), 'New Doc Title');
		await user.click(screen.getByRole('button', { name: 'Create' }));

		expect(fetch).toHaveBeenCalledWith(
			'/api/documents',
			expect.objectContaining({ method: 'POST' })
		);
		await vi.waitFor(() => expect(goto).toHaveBeenCalledWith('/doc/new-doc-id'));
	});

	it('does not create a document when creation is cancelled', async () => {
		vi.stubGlobal('fetch', vi.fn());
		const user = userEvent.setup();
		render(Sidebar, {});

		await user.click(screen.getByRole('button', { name: 'New document' }));
		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(fetch).not.toHaveBeenCalled();
	});

	it('shows an in-page error when document creation fails', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
		const user = userEvent.setup();
		render(Sidebar, {});

		await user.click(screen.getByRole('button', { name: 'New document' }));
		await user.type(screen.getByLabelText('Document title'), 'Title');
		await user.click(screen.getByRole('button', { name: 'Create' }));

		await vi.waitFor(() =>
			expect(screen.getByRole('alert')).toHaveTextContent('Failed to create document.')
		);
	});

	it('deletes a document after confirmation and navigates home if it was the active one', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'To Delete' });
		setPath('/doc/doc-1');
		const user = userEvent.setup();
		render(Sidebar, {});

		await user.click(screen.getByRole('button', { name: 'Delete document' }));
		await user.click(screen.getByRole('button', { name: 'Delete' }));

		expect(screen.queryByText('To Delete')).not.toBeInTheDocument();
		await vi.waitFor(() => expect(goto).toHaveBeenCalledWith('/'));
	});

	it('keeps the document when deletion is cancelled', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'Keep Me' });
		const user = userEvent.setup();
		render(Sidebar, {});

		await user.click(screen.getByRole('button', { name: 'Delete document' }));
		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.getByText('Keep Me')).toBeInTheDocument();
	});

	it('deletes a collection after confirmation', async () => {
		createCollection(ydoc, { id: 'col-1', title: 'Drop Table', schema: [] });
		const user = userEvent.setup();
		render(Sidebar, {});

		await user.click(screen.getByRole('button', { name: 'Delete collection' }));
		await user.click(screen.getByRole('button', { name: 'Delete' }));

		expect(screen.queryByText('Drop Table')).not.toBeInTheDocument();
	});

	it('toggles dark mode via the footer button', async () => {
		const user = userEvent.setup();
		render(Sidebar, {});
		await user.click(screen.getByRole('button', { name: 'Toggle theme' }));
		expect(toggleTheme).toHaveBeenCalledOnce();
	});

	it('links to the tokens and audit settings pages', () => {
		render(Sidebar, {});
		const tokensLink = within(screen.getByLabelText('Workspace sidebar')).getByText('Tokens');
		const auditLink = within(screen.getByLabelText('Workspace sidebar')).getByText('Audit');
		expect(tokensLink.closest('a')).toHaveAttribute('href', '/settings/tokens');
		expect(auditLink.closest('a')).toHaveAttribute('href', '/audit');
	});
});
