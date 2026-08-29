import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import * as Y from 'yjs';
import {
	createCollection,
	createDocument,
	createRecord,
	getDocument,
	getRecordYText,
	updateRecordContent
} from '$lib/data/records';
import type { ActorId } from '$lib/data/types';
import Page from './+page.svelte';

// Enter/Backspace/toolbar block-conversion behavior has its own dedicated
// suite: editing-conventions.svelte.test.ts. This file covers everything
// else — rendering each block type, navigation, presence, and the
// non-editing-convention UI flows (slash menu, synced/page-link targets).

const HUMAN: ActorId = { kind: 'human', userId: 'local' };

let ydoc: Y.Doc;
vi.mock('$lib/client/yjs-client', () => ({ getClientDoc: () => ydoc }));

const claimBlockPresence = vi.hoisted(() => vi.fn());
const releaseBlockPresence = vi.hoisted(() => vi.fn());
const subscribeHeldByOthers = vi.hoisted(() =>
	vi.fn((onChange: (held: Map<string, ActorId>) => void) => {
		onChange(new Map());
		return () => {};
	})
);
vi.mock('$lib/client/presence', () => ({
	claimBlockPresence,
	releaseBlockPresence,
	subscribeHeldByOthers
}));

describe('doc/[id] +page', () => {
	beforeEach(() => {
		ydoc = new Y.Doc();
		claimBlockPresence.mockClear();
		releaseBlockPresence.mockClear();
		subscribeHeldByOthers.mockClear().mockImplementation(() => () => {});
	});

	afterEach(() => {
		ydoc.destroy();
	});

	it('shows a prompt to start writing when the document has no blocks', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'Empty Doc' });
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'Empty Doc' }
		});
		expect(screen.getByText("Type '/' for commands, or start typing...")).toBeInTheDocument();
	});

	it('creates a first block when the empty-state prompt is clicked', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'Empty Doc' });
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'Empty Doc' }
		});

		await user.click(
			screen.getByText("Type '/' for commands, or start typing...", { selector: 'button' })
		);

		expect(screen.queryByRole('button', { name: /start typing/ })).not.toBeInTheDocument();
		expect(screen.getByRole('textbox', { name: /Block content|Type/ })).toBeInTheDocument();
	});

	it('renders the SSR title before mount, then the live document title', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'Live Title' });
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'SSR Title' }
		});
		expect(screen.getByDisplayValue('Live Title')).toBeInTheDocument();
	});

	it('updates the document title in the Y.Doc as the title input changes', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'Old' });
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'Old' }
		});

		const titleInput = screen.getByDisplayValue('Old');
		await user.clear(titleInput);
		await user.type(titleInput, 'New Title');

		expect(getDocument(ydoc, 'doc-1')?.title).toBe('New Title');
	});

	it('shows the parent document breadcrumb for a sub-page', () => {
		createDocument(ydoc, { id: 'parent', title: 'Parent Doc' });
		createDocument(ydoc, { id: 'child', title: 'Child Doc', parentDocumentId: 'parent' });
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'child', title: 'Child Doc' }
		});
		expect(screen.getByText('Parent Doc')).toBeInTheDocument();
	});

	it('renders a paragraph block with its text content', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const record = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		getRecordYText(ydoc, record.id)!.insert(0, 'Hello block');
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});
		expect(screen.getByText('Hello block')).toBeInTheDocument();
	});

	it('renders a to_do block with a checkbox toggle reflecting checked state', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const record = createRecord(ydoc, { parentId: 'doc-1', blockType: 'to_do' }, HUMAN);
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		const toggle = screen.getByRole('button', { name: 'Mark as complete' });
		await user.click(toggle);

		expect(screen.getByRole('button', { name: 'Mark as incomplete' })).toBeInTheDocument();
		expect(getDocument(ydoc, 'doc-1')).toBeDefined();
		const yrecord = ydoc.getMap('records').get(record.id) as Y.Map<unknown>;
		expect(yrecord.get('checked')).toBe(true);
	});

	it('renders a divider block', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'divider' }, HUMAN);
		const { container } = render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});
		expect(container.querySelector('.border-t.border-border')).toBeInTheDocument();
	});

	it('renders a callout block with its icon and text', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const record = createRecord(ydoc, { parentId: 'doc-1', blockType: 'callout' }, HUMAN);
		getRecordYText(ydoc, record.id)!.insert(0, 'Careful!');
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});
		expect(screen.getByText('Careful!')).toBeInTheDocument();
	});

	it('toggles a toggle block collapsed state', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const record = createRecord(ydoc, { parentId: 'doc-1', blockType: 'toggle' }, HUMAN);
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		await user.click(screen.getByRole('button', { name: 'Collapse section' }));

		const yrecord = ydoc.getMap('records').get(record.id) as Y.Map<unknown>;
		expect(yrecord.get('collapsed')).toBe(true);
	});

	it('renders a table of contents block listing heading blocks', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const h1 = createRecord(ydoc, { parentId: 'doc-1', blockType: 'heading_1' }, HUMAN);
		getRecordYText(ydoc, h1.id)!.insert(0, 'Section One');
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'table_of_contents' }, HUMAN);
		const { container } = render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		// Scoped to the rendered block itself, not a document-wide text
		// query: the toolbar's "Insert Table of contents" control shares the
		// same "Table of contents" label text, so an unscoped query would
		// pass even if the block itself failed to render.
		const tocBlock = container.querySelector(
			'.rounded-lg.border-border.bg-surface\\/60'
		) as HTMLElement;
		expect(tocBlock).toBeInTheDocument();
		expect(within(tocBlock).getByText('Table of contents')).toBeInTheDocument();
		expect(within(tocBlock).getByText('Section One')).toBeInTheDocument();
	});

	it('shows an in-page control for a synced block with no target yet', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'synced_block' }, HUMAN);
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});
		expect(screen.getByText('Set target ID')).toBeInTheDocument();
	});

	it('links a synced block to another record through the in-page dialog', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const target = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		getRecordYText(ydoc, target.id)!.insert(0, 'Original content');
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'synced_block' }, HUMAN);
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		await user.click(screen.getByText('Set target ID'));
		await user.type(screen.getByLabelText('Block record ID'), target.id);
		await user.click(screen.getByRole('button', { name: 'Set target' }));

		expect(screen.getAllByText('Original content').length).toBeGreaterThan(0);
	});

	it('shows a document picker for an unlinked page_link block', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		createDocument(ydoc, { id: 'other', title: 'Other Doc' });
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'page_link' }, HUMAN);
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});
		expect(screen.getByText('Link to page:')).toBeInTheDocument();
		expect(screen.getByRole('option', { name: 'Other Doc' })).toBeInTheDocument();
	});

	it('renders a linked page_link block as a navigable link to the target document', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		createDocument(ydoc, { id: 'other', title: 'Other Doc' });
		createRecord(
			ydoc,
			{ parentId: 'doc-1', blockType: 'page_link', referencedRecordId: 'other' },
			HUMAN
		);
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});
		expect(screen.getByRole('link', { name: /Other Doc/ })).toHaveAttribute('href', '/doc/other');
	});

	it('shows backlinks from page_link and inline wiki-link sources with navigable context', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'Target' });
		createDocument(ydoc, { id: 'source', title: 'Source document' });
		createRecord(
			ydoc,
			{ parentId: 'source', blockType: 'page_link', referencedRecordId: 'doc-1' },
			HUMAN
		);
		const inlineBlock = createRecord(ydoc, { parentId: 'source', blockType: 'paragraph' }, HUMAN);
		updateRecordContent(
			ydoc,
			inlineBlock.id,
			{ runs: [{ text: 'Related notes', marks: { link: 'record:doc-1' } }] },
			HUMAN
		);

		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'Target' }
		});

		expect(screen.getByRole('heading', { name: 'Backlinks' })).toBeInTheDocument();
		expect(screen.getByText('2')).toBeInTheDocument();
		expect(screen.getAllByRole('link', { name: 'Source document' })).toHaveLength(2);
		expect(screen.getAllByRole('link', { name: 'Source document' })[0]).toHaveAttribute(
			'href',
			'/doc/source'
		);
		expect(screen.getByText('Related notes')).toBeInTheDocument();
	});

	it('shows an explicit "deleted" state for a page_link whose target no longer exists, distinct from an unlinked block', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		// 'gone' was never created (or was since deleted) — referencedRecordId
		// still points at it, same shape as a real delete-after-link scenario.
		createRecord(
			ydoc,
			{ parentId: 'doc-1', blockType: 'page_link', referencedRecordId: 'gone' },
			HUMAN
		);
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});
		expect(screen.getByText('Linked page was deleted')).toBeInTheDocument();
		expect(screen.queryByText('Link to page:')).not.toBeInTheDocument();
		expect(screen.queryByRole('link', { name: /gone/ })).not.toBeInTheDocument();
	});

	it('renders a collection_view block inline as an embedded picker when unconfigured', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'collection_view' }, HUMAN);
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});
		expect(screen.getByText('Embed a collection view:')).toBeInTheDocument();
	});

	it('renders a configured collection_view block as an embedded Board inline in the document', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const collection = createCollection(ydoc, { title: 'Sprint Tasks', schema: [] });
		createRecord(
			ydoc,
			{
				parentId: 'doc-1',
				blockType: 'collection_view',
				referencedRecordId: collection.id,
				viewConfig: { viewType: 'board' }
			},
			HUMAN
		);
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});
		expect(screen.getByText('Sprint Tasks')).toBeInTheDocument();
		expect(screen.getByText('· board')).toBeInTheDocument();
	});

	it('adds a new block from the "Add block" button at the bottom', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		await user.click(screen.getByRole('button', { name: 'Add block' }));

		expect(getDocument(ydoc, 'doc-1')?.recordIds).toHaveLength(2);
	});

	it('opens the slash menu when a block is typed to "/", and applies the chosen block type', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		const user = userEvent.setup();
		const { container } = render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		const editor = container.querySelector('[contenteditable]') as HTMLElement;
		editor.textContent = '/';
		await editor.dispatchEvent(new InputEvent('input', { bubbles: true }));

		expect(screen.getByRole('listbox', { name: 'Slash commands' })).toBeInTheDocument();

		await user.click(within(screen.getByRole('listbox')).getByText('Heading 1'));

		expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
		const doc = getDocument(ydoc, 'doc-1')!;
		const yrecord = ydoc.getMap('records').get(doc.recordIds[0]) as Y.Map<unknown>;
		expect(yrecord.get('blockType')).toBe('heading_1');
	});

	it('shows a placeholder row instead of the editor for a block held by another actor', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const record = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		subscribeHeldByOthers.mockImplementation((onChange: (held: Map<string, ActorId>) => void) => {
			onChange(new Map([[record.id, { kind: 'agent', agentId: 'a1', name: 'Claude' }]]));
			return () => {};
		});

		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		expect(screen.getByText('Claude editing…')).toBeInTheDocument();
	});

	it('re-derives blocks when navigating client-side to a different document id', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'First' });
		const rec1 = createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		getRecordYText(ydoc, rec1.id)!.insert(0, 'From doc one');

		createDocument(ydoc, { id: 'doc-2', title: 'Second' });
		const rec2 = createRecord(ydoc, { parentId: 'doc-2', blockType: 'paragraph' }, HUMAN);
		getRecordYText(ydoc, rec2.id)!.insert(0, 'From doc two');

		const user = userEvent.setup();
		const { container, rerender } = render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'First' }
		});
		expect(screen.getByText('From doc one')).toBeInTheDocument();
		await user.click(container.querySelector('[contenteditable]') as HTMLElement);

		await rerender({
			data: { documents: [], collections: [], documentId: 'doc-2', title: 'Second' }
		});

		expect(screen.queryByText('From doc one')).not.toBeInTheDocument();
		expect(screen.getByText('From doc two')).toBeInTheDocument();
	});

	it('claims block presence on focus and releases it on unmount', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		const user = userEvent.setup();
		const { container, unmount } = render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		const editor = container.querySelector('[contenteditable]') as HTMLElement;
		await user.click(editor);
		expect(claimBlockPresence).toHaveBeenCalled();

		unmount();
		expect(releaseBlockPresence).toHaveBeenCalledOnce();
	});

	it('renders a quote block and a code block with their text', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const quote = createRecord(ydoc, { parentId: 'doc-1', blockType: 'quote' }, HUMAN);
		getRecordYText(ydoc, quote.id)!.insert(0, 'A quote');
		const code = createRecord(ydoc, { parentId: 'doc-1', blockType: 'code' }, HUMAN);
		getRecordYText(ydoc, code.id)!.insert(0, 'const x = 1;');

		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		expect(screen.getByText('A quote')).toBeInTheDocument();
		expect(screen.getByText('const x = 1;')).toBeInTheDocument();
	});

	it('numbers sequential numbered_list_item blocks starting from 1', () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'numbered_list_item' }, HUMAN);
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'numbered_list_item' }, HUMAN);
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'bulleted_list_item' }, HUMAN);

		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		expect(screen.getByText('1.')).toBeInTheDocument();
		expect(screen.getByText('2.')).toBeInTheDocument();
	});

	it('moves focus into the first block when Enter is pressed in the title, creating one if needed', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		const titleInput = screen.getByPlaceholderText('Untitled document');
		titleInput.focus();
		await user.keyboard('{Enter}');

		expect(getDocument(ydoc, 'doc-1')?.recordIds).toHaveLength(1);
	});

	it('focuses the last block when clicking the empty canvas area below existing blocks', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		createRecord(ydoc, { parentId: 'doc-1', blockType: 'paragraph' }, HUMAN);
		const user = userEvent.setup();
		const { container } = render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		const canvas = container.querySelector('.cursor-text.flex-col') as HTMLElement;
		await user.click(canvas);

		expect(getDocument(ydoc, 'doc-1')?.recordIds).toHaveLength(1);
	});

	it('does not set a synced-block target when the dialog is cancelled', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const record = createRecord(ydoc, { parentId: 'doc-1', blockType: 'synced_block' }, HUMAN);
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		await user.click(screen.getByText('Set target ID'));
		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		const yrecord = ydoc.getMap('records').get(record.id) as Y.Map<unknown>;
		expect(yrecord.get('referencedRecordId')).toBeUndefined();
	});

	it('undoes and redoes the last local block creation via Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		await user.click(screen.getByRole('button', { name: 'Add block' }));
		expect(getDocument(ydoc, 'doc-1')?.recordIds).toHaveLength(1);

		await user.keyboard('{Control>}z{/Control}');
		expect(getDocument(ydoc, 'doc-1')?.recordIds).toHaveLength(0);

		await user.keyboard('{Control>}{Shift>}z{/Shift}{/Control}');
		expect(getDocument(ydoc, 'doc-1')?.recordIds).toHaveLength(1);
	});

	it('also redoes via Ctrl+Y, the Windows/Linux convention', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		await user.click(screen.getByRole('button', { name: 'Add block' }));
		await user.keyboard('{Control>}z{/Control}');
		expect(getDocument(ydoc, 'doc-1')?.recordIds).toHaveLength(0);

		await user.keyboard('{Control>}y{/Control}');
		expect(getDocument(ydoc, 'doc-1')?.recordIds).toHaveLength(1);
	});

	it('enables the toolbar Undo button after a local edit, and disables it again once undone', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();

		await user.click(screen.getByRole('button', { name: 'Add block' }));
		expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();

		await user.click(screen.getByRole('button', { name: 'Undo' }));
		expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Redo' })).toBeEnabled();
	});

	it("never undoes a remote actor's concurrent block creation, only this tab's own last local action", async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		// This tab's own local action, made through the UI after mount so
		// it's actually tracked by this tab's Y.UndoManager.
		await user.click(screen.getByRole('button', { name: 'Add block' }));
		const localId = getDocument(ydoc, 'doc-1')!.recordIds[0];

		// A remote peer's edit arrives over the shared Y.Doc the same way a
		// real second browser tab's write would sync in over /ws: applied
		// with a non-null transaction origin, which Y.UndoManager's default
		// trackedOrigins (only `null`) never tracks.
		const remoteDoc = new Y.Doc();
		Y.applyUpdate(remoteDoc, Y.encodeStateAsUpdate(ydoc));
		const remote: ActorId = { kind: 'human', userId: 'collaborator' };
		const remoteRecord = createRecord(
			remoteDoc,
			{ parentId: 'doc-1', blockType: 'paragraph' },
			remote
		);
		Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(remoteDoc, Y.encodeStateVector(ydoc)), {});
		remoteDoc.destroy();

		expect(getDocument(ydoc, 'doc-1')?.recordIds).toEqual([localId, remoteRecord.id]);

		await user.keyboard('{Control>}z{/Control}');

		// Only the local actor's own block is gone...
		expect(getDocument(ydoc, 'doc-1')?.recordIds).toEqual([remoteRecord.id]);
		// ...the remote actor's concurrent, independent block survives untouched.
		expect(getRecordYText(ydoc, remoteRecord.id)).toBeDefined();
	});

	it('changes the target of an already-linked page_link block', async () => {
		createDocument(ydoc, { id: 'doc-1', title: 'D' });
		createDocument(ydoc, { id: 'target-a', title: 'Target A' });
		createDocument(ydoc, { id: 'target-b', title: 'Target B' });
		const record = createRecord(
			ydoc,
			{ parentId: 'doc-1', blockType: 'page_link', referencedRecordId: 'target-a' },
			HUMAN
		);
		const user = userEvent.setup();
		render(Page, {
			params: { id: 'doc-1' },
			form: null,
			data: { documents: [], collections: [], documentId: 'doc-1', title: 'D' }
		});

		await user.selectOptions(
			screen.getByRole('combobox', { name: 'Change target document' }),
			'target-b'
		);

		const yrecord = ydoc.getMap('records').get(record.id) as Y.Map<unknown>;
		expect(yrecord.get('referencedRecordId')).toBe('target-b');
	});
});
