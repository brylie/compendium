import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import * as Y from 'yjs';
import Layout from './+layout.svelte';

function textSnippet(text: string) {
	return createRawSnippet(() => ({
		render: () => `<p>${text}</p>`
	}));
}

vi.mock('$app/state', () => ({
	get page() {
		return { url: new URL('http://localhost/'), params: {} };
	}
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$lib/client/theme', () => ({ isDark: vi.fn(() => false), toggleTheme: vi.fn() }));

let ydoc: Y.Doc;
vi.mock('$lib/client/yjs-client', () => ({ getClientDoc: () => ydoc }));

describe('+layout', () => {
	beforeEach(() => {
		ydoc = new Y.Doc();
	});

	afterEach(() => {
		ydoc.destroy();
	});

	it('renders the sidebar alongside the routed page content', () => {
		render(Layout, {
			params: {},
			data: { spaces: [], activeSpaceId: 'space-1', documents: [], collections: [] },
			children: textSnippet('Routed page content')
		});

		expect(screen.getByLabelText('Workspace sidebar')).toBeInTheDocument();
		expect(screen.getByText('Routed page content')).toBeInTheDocument();
	});

	it('passes SSR document and collection snapshots down to the sidebar', () => {
		render(Layout, {
			params: {},
			data: {
				spaces: [],
				activeSpaceId: 'space-1',
				documents: [{ id: 'd1', title: 'From Layout', order: 'a', recordIds: [] }],
				collections: []
			},
			children: textSnippet('')
		});

		expect(screen.getByText('From Layout')).toBeInTheDocument();
	});
});
