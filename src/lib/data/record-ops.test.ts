import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DEFAULT_CUSTOM_CALLOUT_COLOR } from './callout-style';
import { createDocument, listDocuments } from './document-ops';
import { createCollection, listCollections } from './collection-ops';
import {
	createColumnsBlock,
	createRecord,
	deleteRecord,
	detachSyncedBlock,
	duplicateRecord,
	flattenDocumentBlocks,
	getRecord,
	getRecordYText,
	listRecordsForParent,
	moveRecordToParent,
	parentKindOf,
	patchRecordViewConfig,
	reorderRecord,
	setBlockType,
	setRecordBookmarkMetadata,
	setRecordCalloutStyle,
	setRecordChecked,
	setRecordCollapsed,
	setRecordFullWidth,
	setRecordReferencedId,
	setRecordUrl,
	setRecordViewConfig,
	touchRecordEditor,
	updateRecordContent,
	updateRecordProperties
} from './record-ops';
import { copyDocumentVerbatim } from './migration-copy';
import { NotFoundError, ValidationError } from './errors';
import { yTextToRichText } from './richtext';
import { blockTypes, type ActorId } from './types';

const human: ActorId = { kind: 'human', userId: 'brylie' };
const agent: ActorId = { kind: 'agent', agentId: 'a1', name: 'Research Agent' };

describe('records: unified addressing', () => {
	it('addresses a Document block and a Collection row through the same API', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const collection = createCollection(doc, {
			title: 'Tasks',
			schema: [{ key: 'status', label: 'Status', type: 'select' }]
		});

		const block = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		const row = createRecord(
			doc,
			{ parentId: collection.id, properties: { status: { type: 'select', value: 'todo' } } },
			human
		);

		// Same read function works for both, regardless of which "view" created them.
		expect(getRecord(doc, block.id)?.parentId).toBe(document.id);
		expect(getRecord(doc, row.id)?.parentId).toBe(collection.id);
		expect(getRecord(doc, row.id)?.properties?.status).toEqual({ type: 'select', value: 'todo' });
	});

	it('lists documents and collections independently, with zero migration needed for new views', () => {
		const doc = new Y.Doc();
		createDocument(doc, { title: 'A' });
		createCollection(doc, { title: 'B', schema: [] });

		expect(listDocuments(doc)).toHaveLength(1);
		expect(listCollections(doc)).toHaveLength(1);
	});

	it('never persists blockType on a Collection row, regardless of the requested block type', () => {
		const doc = new Y.Doc();
		const collection = createCollection(doc, { title: 'Tasks', schema: [] });

		for (const blockType of blockTypes) {
			const row = createRecord(doc, { parentId: collection.id, blockType }, human);
			expect(getRecord(doc, row.id)?.blockType).toBeUndefined();
		}
	});

	it('orders a Document block sequence and keeps it in sync on delete', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const first = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		const second = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		const third = createRecord(
			doc,
			{ parentId: document.id, blockType: 'paragraph', afterRecordId: first.id },
			human
		);

		expect(listRecordsForParent(doc, document.id).map((r) => r.id)).toEqual([
			first.id,
			third.id,
			second.id
		]);

		deleteRecord(doc, third.id);
		expect(listRecordsForParent(doc, document.id).map((r) => r.id)).toEqual([first.id, second.id]);
	});
});

describe('records: CRDT merge acceptance criteria', () => {
	it('merges concurrent overlapping bold/italic formatting with no corrupted or lost marks', () => {
		const docA = new Y.Doc();
		const document = createDocument(docA, { title: 'Notes' });
		const block = createRecord(docA, { parentId: document.id, blockType: 'paragraph' }, human);
		updateRecordContent(docA, block.id, { runs: [{ text: 'hello world', marks: {} }] }, human);

		const docB = new Y.Doc();
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

		const ytextA = (docA.getMap('records').get(block.id) as Y.Map<unknown>).get(
			'content'
		) as Y.Text;
		const ytextB = (docB.getMap('records').get(block.id) as Y.Map<unknown>).get(
			'content'
		) as Y.Text;

		// Replica A bolds "hello", replica B italicizes "lo world" — overlapping on "lo".
		docA.transact(() => ytextA.format(0, 5, { bold: true }));
		docB.transact(() => ytextB.format(3, 8, { italic: true }));

		// Sync both directions.
		const updateFromA = Y.encodeStateAsUpdate(docA);
		const updateFromB = Y.encodeStateAsUpdate(docB);
		Y.applyUpdate(docB, updateFromA);
		Y.applyUpdate(docA, updateFromB);

		const richTextA = yTextToRichText(ytextA);
		const richTextB = yTextToRichText(ytextB);

		// Both replicas converge to the same merged result.
		expect(richTextA).toEqual(richTextB);

		const plain = richTextA.runs.map((r) => r.text).join('');
		expect(plain).toBe('hello world');

		// "hel" is bold only, "lo" is bold+italic (the overlap), " world" tail is italic only.
		const bolded = richTextA.runs
			.filter((r) => r.marks.bold)
			.map((r) => r.text)
			.join('');
		const italicized = richTextA.runs
			.filter((r) => r.marks.italic)
			.map((r) => r.text)
			.join('');
		const both = richTextA.runs
			.filter((r) => r.marks.bold && r.marks.italic)
			.map((r) => r.text)
			.join('');

		expect(bolded).toBe('hello');
		expect(italicized).toBe('lo world');
		expect(both).toBe('lo');
	});

	it('merges concurrent property edits on different fields of the same row', () => {
		const docA = new Y.Doc();
		const collection = createCollection(docA, {
			title: 'Tasks',
			schema: [
				{ key: 'status', label: 'Status', type: 'select' },
				{ key: 'owner', label: 'Owner', type: 'text' }
			]
		});
		const row = createRecord(
			docA,
			{ parentId: collection.id, properties: { status: { type: 'select', value: 'todo' } } },
			human
		);

		const docB = new Y.Doc();
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

		updateRecordProperties(docA, row.id, { status: { type: 'select', value: 'done' } }, human);
		updateRecordProperties(docB, row.id, { owner: { type: 'text', value: 'Brylie' } }, agent);

		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
		Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

		const merged = getRecord(docA, row.id);
		expect(merged?.properties?.status).toEqual({ type: 'select', value: 'done' });
		expect(merged?.properties?.owner).toEqual({ type: 'text', value: 'Brylie' });
	});

	// Issue #71: viewConfig was previously stored as one whole-value Y.Map
	// entry, so two actors patching different members concurrently (one's
	// filter change, another's sort change) would resolve via last-write-wins
	// on the *entire* object — whichever patch's transaction landed later
	// would silently reintroduce its own stale copy of the member it didn't
	// touch, dropping the other actor's edit. patchRecordViewConfig now writes
	// each member to its own `viewConfig:<field>` entry, so this merges
	// per-member instead, the same way updateRecordProperties already does
	// for row properties (previous test).
	it('merges concurrent viewConfig patches on different members of the same collection_view block', () => {
		const docA = new Y.Doc();
		const collection = createCollection(docA, {
			title: 'Tasks',
			schema: [{ key: 'status', label: 'Status', type: 'select' }]
		});
		const document = createDocument(docA, { title: 'Doc' });
		const block = createRecord(
			docA,
			{
				parentId: document.id,
				blockType: 'collection_view',
				referencedRecordId: collection.id,
				viewConfig: { viewType: 'board', groupBy: 'status' }
			},
			human
		);

		const docB = new Y.Doc();
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

		patchRecordViewConfig(
			docA,
			block.id,
			{ filters: [{ propertyKey: 'status', op: 'is', value: 'todo' }] },
			human
		);
		patchRecordViewConfig(
			docB,
			block.id,
			{ sort: { mode: 'property', propertyKey: 'status', direction: 'asc' } },
			agent
		);

		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
		Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

		const expected = {
			viewType: 'board',
			groupBy: 'status',
			filters: [{ propertyKey: 'status', op: 'is', value: 'todo' }],
			sort: { mode: 'property', propertyKey: 'status', direction: 'asc' }
		};
		// Both replicas converge to the same merged result, not just the one
		// that happened to receive the other's update second.
		expect(getRecord(docA, block.id)?.viewConfig).toEqual(expected);
		expect(getRecord(docB, block.id)?.viewConfig).toEqual(expected);
	});
});

describe('records: creation ordering, mutation, and not-found edge cases', () => {
	it('createRecord throws NotFoundError for an unknown parent', () => {
		const doc = new Y.Doc();
		expect(() => createRecord(doc, { parentId: 'missing', blockType: 'paragraph' }, human)).toThrow(
			NotFoundError
		);
	});

	it('createRecord inserts between two existing siblings via afterRecordId', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const first = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		const second = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		const middle = createRecord(
			doc,
			{ parentId: document.id, blockType: 'paragraph', afterRecordId: first.id },
			human
		);
		expect(listRecordsForParent(doc, document.id).map((r) => r.id)).toEqual([
			first.id,
			middle.id,
			second.id
		]);
	});

	it('createRecord defaults an empty properties object for a collection row with no properties given', () => {
		const doc = new Y.Doc();
		const collection = createCollection(doc, { title: 'Tasks', schema: [] });
		const row = createRecord(doc, { parentId: collection.id }, human);
		expect(getRecord(doc, row.id)?.properties).toEqual({});
	});

	describe('createRecord: select field default option (issue #100)', () => {
		it('seeds a select field’s configured default onto a new collection row', () => {
			const doc = new Y.Doc();
			const collection = createCollection(doc, {
				title: 'Tasks',
				schema: [
					{
						key: 'status',
						label: 'Status',
						type: 'select',
						options: [
							{ id: 'todo', label: 'To do' },
							{ id: 'done', label: 'Done' }
						],
						defaultOptionId: 'todo'
					}
				]
			});
			const row = createRecord(doc, { parentId: collection.id }, human);
			expect(getRecord(doc, row.id)?.properties?.status).toEqual({ type: 'select', value: 'todo' });
		});

		it('lets a caller-supplied value for the same field override the configured default', () => {
			const doc = new Y.Doc();
			const collection = createCollection(doc, {
				title: 'Tasks',
				schema: [
					{
						key: 'status',
						label: 'Status',
						type: 'select',
						options: [
							{ id: 'todo', label: 'To do' },
							{ id: 'done', label: 'Done' }
						],
						defaultOptionId: 'todo'
					}
				]
			});
			const row = createRecord(
				doc,
				{ parentId: collection.id, properties: { status: { type: 'select', value: 'done' } } },
				human
			);
			expect(getRecord(doc, row.id)?.properties?.status).toEqual({ type: 'select', value: 'done' });
		});

		it('leaves a select field with no configured default unset, same as before', () => {
			const doc = new Y.Doc();
			const collection = createCollection(doc, {
				title: 'Tasks',
				schema: [
					{
						key: 'status',
						label: 'Status',
						type: 'select',
						options: [{ id: 'todo', label: 'To do' }]
					}
				]
			});
			const row = createRecord(doc, { parentId: collection.id }, human);
			expect(getRecord(doc, row.id)?.properties?.status).toBeUndefined();
		});

		it('skips a defaultOptionId that no longer names an existing option', () => {
			const doc = new Y.Doc();
			const collection = createCollection(doc, {
				title: 'Tasks',
				schema: [
					{
						key: 'status',
						label: 'Status',
						type: 'select',
						options: [{ id: 'todo', label: 'To do' }],
						defaultOptionId: 'archived-option-id'
					}
				]
			});
			const row = createRecord(doc, { parentId: collection.id }, human);
			expect(getRecord(doc, row.id)?.properties?.status).toBeUndefined();
		});

		it('does not seed a default for a document block (defaults only apply to collection rows)', () => {
			const doc = new Y.Doc();
			const document = createDocument(doc, { title: 'Notes' });
			const block = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
			expect(getRecord(doc, block.id)?.properties).toBeUndefined();
		});
	});

	it('updateRecordContent throws NotFoundError for an unknown record', () => {
		const doc = new Y.Doc();
		expect(() => updateRecordContent(doc, 'missing', { runs: [] }, human)).toThrow(NotFoundError);
	});

	it('updateRecordContent throws when the record has no block content (a collection row)', () => {
		const doc = new Y.Doc();
		const collection = createCollection(doc, { title: 'Tasks', schema: [] });
		const row = createRecord(doc, { parentId: collection.id, properties: {} }, human);
		expect(() => updateRecordContent(doc, row.id, { runs: [] }, human)).toThrow(
			/has no block content/
		);
	});

	it('updateRecordProperties throws NotFoundError for an unknown record', () => {
		const doc = new Y.Doc();
		expect(() =>
			updateRecordProperties(doc, 'missing', { status: { type: 'text', value: 'x' } }, human)
		).toThrow(NotFoundError);
	});

	it("setBlockType changes a block's type and throws NotFoundError for an unknown record", () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		setBlockType(doc, block.id, 'heading_1', human);
		expect(getRecord(doc, block.id)?.blockType).toBe('heading_1');
		expect(() => setBlockType(doc, 'missing', 'heading_1', human)).toThrow(NotFoundError);
	});

	it('setRecordChecked toggles a to_do block and throws NotFoundError for an unknown record', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'to_do' }, human);
		setRecordChecked(doc, block.id, true, human);
		expect(getRecord(doc, block.id)?.checked).toBe(true);
		expect(() => setRecordChecked(doc, 'missing', true, human)).toThrow(NotFoundError);
	});

	it('setRecordCollapsed toggles a toggle block and throws NotFoundError for an unknown record', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'toggle' }, human);
		setRecordCollapsed(doc, block.id, true, human);
		expect(getRecord(doc, block.id)?.collapsed).toBe(true);
		expect(() => setRecordCollapsed(doc, 'missing', true, human)).toThrow(NotFoundError);
	});

	it('setRecordFullWidth toggles a collection_view block full-width, round-trips through createRecord/copyDocumentVerbatim, and throws NotFoundError for an unknown record (issue #150)', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'collection_view' }, human);
		expect(getRecord(doc, block.id)?.fullWidth).toBeUndefined();

		setRecordFullWidth(doc, block.id, true, human);
		expect(getRecord(doc, block.id)?.fullWidth).toBe(true);

		setRecordFullWidth(doc, block.id, false, human);
		expect(getRecord(doc, block.id)?.fullWidth).toBe(false);

		expect(() => setRecordFullWidth(doc, 'missing', true, human)).toThrow(NotFoundError);

		setRecordFullWidth(doc, block.id, true, human);
		const targetDoc = new Y.Doc();
		copyDocumentVerbatim(doc, targetDoc, document.id);
		expect(getRecord(targetDoc, block.id)?.fullWidth).toBe(true);
	});

	it('createRecord accepts fullWidth directly, matching the collapsed/calloutStyle creation-time precedent (issue #150)', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(
			doc,
			{ parentId: document.id, blockType: 'collection_view', fullWidth: true },
			human
		);
		expect(getRecord(doc, block.id)?.fullWidth).toBe(true);
	});

	it('setRecordCalloutStyle sets a preset or custom style on a callout block, clears it back to the default with null, and throws NotFoundError for an unknown record (issue #42)', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'callout' }, human);
		expect(getRecord(doc, block.id)?.calloutStyle).toBeUndefined();

		setRecordCalloutStyle(doc, block.id, { kind: 'preset', preset: 'caution' }, human);
		expect(getRecord(doc, block.id)?.calloutStyle).toEqual({ kind: 'preset', preset: 'caution' });

		setRecordCalloutStyle(doc, block.id, { kind: 'custom', icon: 'star', color: '#123456' }, human);
		expect(getRecord(doc, block.id)?.calloutStyle).toEqual({
			kind: 'custom',
			icon: 'star',
			color: '#123456'
		});

		setRecordCalloutStyle(doc, block.id, null, human);
		expect(getRecord(doc, block.id)?.calloutStyle).toBeUndefined();

		expect(() =>
			setRecordCalloutStyle(doc, 'missing', { kind: 'preset', preset: 'note' }, human)
		).toThrow(NotFoundError);
	});

	it('setRecordCalloutStyle and createRecord fall back to the default color for a malformed custom hex value (issue #42)', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'callout' }, human);

		setRecordCalloutStyle(
			doc,
			block.id,
			{ kind: 'custom', icon: 'star', color: 'not-a-color' },
			human
		);
		expect(getRecord(doc, block.id)?.calloutStyle).toEqual({
			kind: 'custom',
			icon: 'star',
			color: DEFAULT_CUSTOM_CALLOUT_COLOR
		});

		const created = createRecord(
			doc,
			{
				parentId: document.id,
				blockType: 'callout',
				calloutStyle: { kind: 'custom', icon: 'lightbulb', color: 'javascript:alert(1)' }
			},
			human
		);
		expect(getRecord(doc, created.id)?.calloutStyle).toEqual({
			kind: 'custom',
			icon: 'lightbulb',
			color: DEFAULT_CUSTOM_CALLOUT_COLOR
		});
	});

	it('createRecord accepts an initial calloutStyle, and copyDocumentVerbatim preserves it (issue #42)', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(
			doc,
			{
				parentId: document.id,
				blockType: 'callout',
				calloutStyle: { kind: 'preset', preset: 'tip' }
			},
			human
		);
		expect(getRecord(doc, block.id)?.calloutStyle).toEqual({ kind: 'preset', preset: 'tip' });

		const targetDoc = new Y.Doc();
		copyDocumentVerbatim(doc, targetDoc, document.id);
		expect(getRecord(targetDoc, block.id)?.calloutStyle).toEqual({ kind: 'preset', preset: 'tip' });
	});

	it('createRecord accepts an initial url/bookmarkMetadata for a bookmark block, and copyDocumentVerbatim preserves them (issue #155)', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(
			doc,
			{
				parentId: document.id,
				blockType: 'bookmark',
				url: 'https://example.com/article',
				bookmarkMetadata: { status: 'pending' }
			},
			human
		);
		expect(getRecord(doc, block.id)?.url).toBe('https://example.com/article');
		expect(getRecord(doc, block.id)?.bookmarkMetadata).toEqual({ status: 'pending' });

		const targetDoc = new Y.Doc();
		copyDocumentVerbatim(doc, targetDoc, document.id);
		expect(getRecord(targetDoc, block.id)?.url).toBe('https://example.com/article');
		expect(getRecord(targetDoc, block.id)?.bookmarkMetadata).toEqual({ status: 'pending' });
	});

	it('a bookmark block created with no url is unconfigured, like an unconfigured page_link/collection_view (issue #155)', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'bookmark' }, human);
		expect(getRecord(doc, block.id)?.url).toBeUndefined();
		expect(getRecord(doc, block.id)?.bookmarkMetadata).toBeUndefined();
	});

	it('setRecordUrl sets a bookmark block’s url, throws ValidationError on a non-bookmark block, and NotFoundError for an unknown record (issue #155)', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const bookmark = createRecord(doc, { parentId: document.id, blockType: 'bookmark' }, human);
		const paragraph = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);

		setRecordUrl(doc, bookmark.id, 'https://example.com/', human);
		expect(getRecord(doc, bookmark.id)?.url).toBe('https://example.com/');

		expect(() => setRecordUrl(doc, paragraph.id, 'https://example.com/', human)).toThrow(
			ValidationError
		);
		expect(() => setRecordUrl(doc, 'missing', 'https://example.com/', human)).toThrow(
			NotFoundError
		);
	});

	it('setRecordBookmarkMetadata replaces the whole metadata value and throws NotFoundError for an unknown record (issue #155)', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(
			doc,
			{ parentId: document.id, blockType: 'bookmark', url: 'https://example.com/' },
			human
		);

		setRecordBookmarkMetadata(doc, block.id, { status: 'pending' }, human);
		expect(getRecord(doc, block.id)?.bookmarkMetadata).toEqual({ status: 'pending' });

		setRecordBookmarkMetadata(
			doc,
			block.id,
			{ status: 'ready', title: 'Example', fetchedAt: 12345 },
			human
		);
		expect(getRecord(doc, block.id)?.bookmarkMetadata).toEqual({
			status: 'ready',
			title: 'Example',
			fetchedAt: 12345
		});

		expect(() => setRecordBookmarkMetadata(doc, 'missing', { status: 'error' }, human)).toThrow(
			NotFoundError
		);
	});

	it('createRecord accepts an initial referencedRecordId/childPagesDepth for a child_pages block, and copyDocumentVerbatim preserves them (issue #43)', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const other = createDocument(doc, { title: 'Other' });
		const block = createRecord(
			doc,
			{
				parentId: document.id,
				blockType: 'child_pages',
				referencedRecordId: other.id,
				childPagesDepth: 2
			},
			human
		);
		expect(getRecord(doc, block.id)?.referencedRecordId).toBe(other.id);
		expect(getRecord(doc, block.id)?.childPagesDepth).toBe(2);

		const targetDoc = new Y.Doc();
		copyDocumentVerbatim(doc, targetDoc, document.id);
		expect(getRecord(targetDoc, block.id)?.referencedRecordId).toBe(other.id);
		expect(getRecord(targetDoc, block.id)?.childPagesDepth).toBe(2);
	});

	it('setRecordReferencedId points a page_link block at another document and throws NotFoundError for an unknown record', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const target = createDocument(doc, { title: 'Target' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'page_link' }, human);
		setRecordReferencedId(doc, block.id, target.id, human);
		expect(getRecord(doc, block.id)?.referencedRecordId).toBe(target.id);
		expect(() => setRecordReferencedId(doc, 'missing', target.id, human)).toThrow(NotFoundError);
	});

	it("setRecordViewConfig stores a collection_view block's config and throws NotFoundError for an unknown record", () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'collection_view' }, human);
		setRecordViewConfig(doc, block.id, { viewType: 'board', groupBy: 'status' }, human);
		expect(getRecord(doc, block.id)?.viewConfig).toEqual({ viewType: 'board', groupBy: 'status' });
		expect(() => setRecordViewConfig(doc, 'missing', { viewType: 'table' }, human)).toThrow(
			NotFoundError
		);
	});

	it('setRecordViewConfig fully replaces a prior config, clearing any member absent from the new one', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'collection_view' }, human);
		setRecordViewConfig(
			doc,
			block.id,
			{
				viewType: 'table',
				filters: [{ propertyKey: 'status', op: 'is', value: 'todo' }],
				groupBy: 'status'
			},
			human
		);
		setRecordViewConfig(doc, block.id, { viewType: 'table', sort: { mode: 'manual' } }, human);
		expect(getRecord(doc, block.id)?.viewConfig).toEqual({
			viewType: 'table',
			sort: { mode: 'manual' }
		});
	});

	it("patchRecordViewConfig merges only the named members, leaving the rest of a collection_view block's config untouched", () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(
			doc,
			{
				parentId: document.id,
				blockType: 'collection_view',
				viewConfig: {
					viewType: 'board',
					filters: [{ propertyKey: 'status', op: 'is', value: 'todo' }],
					groupBy: 'status'
				}
			},
			human
		);

		patchRecordViewConfig(
			doc,
			block.id,
			{ sort: { mode: 'property', propertyKey: 'status', direction: 'asc' } },
			human
		);
		expect(getRecord(doc, block.id)?.viewConfig).toEqual({
			viewType: 'board',
			filters: [{ propertyKey: 'status', op: 'is', value: 'todo' }],
			groupBy: 'status',
			sort: { mode: 'property', propertyKey: 'status', direction: 'asc' }
		});

		// A member explicitly named with an `undefined` value clears it rather
		// than being treated as "not part of this patch".
		patchRecordViewConfig(doc, block.id, { groupBy: undefined }, human);
		expect(getRecord(doc, block.id)?.viewConfig?.groupBy).toBeUndefined();
		expect(getRecord(doc, block.id)?.viewConfig?.filters).toEqual([
			{ propertyKey: 'status', op: 'is', value: 'todo' }
		]);

		expect(() => patchRecordViewConfig(doc, 'missing', { groupBy: 'status' }, human)).toThrow(
			NotFoundError
		);
	});

	it('patchRecordViewConfig rejects a viewType key at runtime, even past a type-system bypass', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(
			doc,
			{ parentId: document.id, blockType: 'collection_view', viewConfig: { viewType: 'board' } },
			human
		);

		// Partial<ViewConfig> already blocks this at compile time for a typed
		// caller — this simulates an untyped caller or an unsafe cast getting
		// `viewType` into the patch anyway.
		expect(() =>
			patchRecordViewConfig(
				doc,
				block.id,
				{ viewType: 'calendar' } as Partial<import('./views').ViewConfig>,
				human
			)
		).toThrow(ValidationError);
		// Rejected before any write — the config is untouched.
		expect(getRecord(doc, block.id)?.viewConfig).toEqual({ viewType: 'board' });
	});

	it('reads a pre-#183 legacy whole-value viewConfig, and patchRecordViewConfig migrates it into per-member entries on first write', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'collection_view' }, human);

		// Simulate a record persisted before #183: the whole config under one
		// `viewConfig` key, bypassing writeViewConfig/setRecordViewConfig
		// entirely so this doesn't just re-exercise the new write path.
		const yrecord = (doc.getMap('records') as Y.Map<Y.Map<unknown>>).get(block.id)!;
		const legacyConfig = {
			viewType: 'board' as const,
			filters: [{ propertyKey: 'status', op: 'is' as const, value: 'todo' }],
			groupBy: 'status'
		};
		yrecord.set('viewConfig', legacyConfig);

		// readViewConfig falls back to the legacy key read-only — an existing
		// embed doesn't look unconfigured just because this PR shipped.
		expect(getRecord(doc, block.id)?.viewConfig).toEqual(legacyConfig);
		expect(yrecord.has('viewConfig:viewType')).toBe(false);

		patchRecordViewConfig(doc, block.id, { sort: { mode: 'manual' } }, human);

		// The patch's first write migrates the legacy value into prefixed
		// entries (and removes the legacy key) before applying itself, so the
		// patch lands on top of the migrated data instead of being shadowed by
		// the still-present legacy object on the next read.
		expect(yrecord.has('viewConfig')).toBe(false);
		expect(getRecord(doc, block.id)?.viewConfig).toEqual({
			...legacyConfig,
			sort: { mode: 'manual' }
		});
	});

	it('createRecord accepts an initial viewConfig for a collection_view block', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(
			doc,
			{ parentId: document.id, blockType: 'collection_view', viewConfig: { viewType: 'calendar' } },
			human
		);
		expect(getRecord(doc, block.id)?.viewConfig).toEqual({ viewType: 'calendar' });
	});

	it('deleteRecord is a no-op for a nonexistent id', () => {
		const doc = new Y.Doc();
		expect(() => deleteRecord(doc, 'missing')).not.toThrow();
	});

	it('getRecordYText returns the Y.Text for a block and undefined for an unknown record', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		expect(getRecordYText(doc, block.id)).toBeInstanceOf(Y.Text);
		expect(getRecordYText(doc, 'missing')).toBeUndefined();
	});

	it('touchRecordEditor updates lastEditedBy/At and no-ops for an unknown record', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const block = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		touchRecordEditor(doc, block.id, agent);
		expect(getRecord(doc, block.id)?.lastEditedBy).toEqual(agent);
		expect(() => touchRecordEditor(doc, 'missing', agent)).not.toThrow();
	});

	it('listRecordsForParent returns an empty list for an unknown parent', () => {
		const doc = new Y.Doc();
		expect(listRecordsForParent(doc, 'missing')).toEqual([]);
	});
});

describe('reorderRecord: block drag-and-drop repositioning (#40)', () => {
	function setup() {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const a = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		const b = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		const c = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		const d = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		return { doc, document, a, b, c, d };
	}

	function ids(doc: Y.Doc, parentId: string): string[] {
		return listRecordsForParent(doc, parentId).map((r) => r.id);
	}

	it('moves a block to the very start when afterRecordId is omitted', () => {
		const { doc, document, a, b, c, d } = setup();
		reorderRecord(doc, d.id);
		expect(ids(doc, document.id)).toEqual([d.id, a.id, b.id, c.id]);
	});

	it('moves a block to the middle via afterRecordId', () => {
		const { doc, document, a, b, c, d } = setup();
		reorderRecord(doc, a.id, b.id);
		expect(ids(doc, document.id)).toEqual([b.id, a.id, c.id, d.id]);
	});

	it('moves a block to the very end via the last sibling as afterRecordId', () => {
		const { doc, document, a, b, c, d } = setup();
		reorderRecord(doc, a.id, d.id);
		expect(ids(doc, document.id)).toEqual([b.id, c.id, d.id, a.id]);
	});

	it('changes only position — content, blockType, and provenance are untouched', () => {
		const { doc, a, b } = setup();
		const ytext = getRecordYText(doc, a.id)!;
		doc.transact(() => ytext.insert(0, 'hello'));
		const before = getRecord(doc, a.id)!;

		reorderRecord(doc, a.id, b.id);

		const after = getRecord(doc, a.id)!;
		expect(after.blockType).toBe(before.blockType);
		expect(yTextToRichText(getRecordYText(doc, a.id)!)).toEqual(yTextToRichText(ytext));
		expect(after.createdBy).toEqual(before.createdBy);
		expect(after.lastEditedBy).toEqual(before.lastEditedBy);
		expect(after.lastEditedAt).toEqual(before.lastEditedAt);
	});

	it('throws NotFoundError for an unknown record id', () => {
		const { doc } = setup();
		expect(() => reorderRecord(doc, 'missing')).toThrow(NotFoundError);
	});

	it('throws NotFoundError when afterRecordId is not an existing sibling', () => {
		const { doc, a } = setup();
		expect(() => reorderRecord(doc, a.id, 'missing')).toThrow(NotFoundError);
	});

	it('throws ValidationError when afterRecordId is the record itself', () => {
		const { doc, a } = setup();
		expect(() => reorderRecord(doc, a.id, a.id)).toThrow(ValidationError);
	});

	it('throws ValidationError for a Collection row (only Document blocks are reorderable)', () => {
		const doc = new Y.Doc();
		const collection = createCollection(doc, { title: 'Tasks', schema: [] });
		const row = createRecord(doc, { parentId: collection.id, properties: {} }, human);
		expect(() => reorderRecord(doc, row.id)).toThrow(ValidationError);
	});

	it('deleteRecord removes every occurrence of an id, cleaning up a leftover duplicate from a concurrent move', () => {
		const { doc, document, a, b, c, d } = setup();
		// Simulate the leftover a concurrent reorderRecord move of the same
		// block by two actors can produce (see reorderRecord's doc comment):
		// two entries for `a` in the same recordIds array.
		const ymeta = doc.getMap('documents').get(document.id) as Y.Map<unknown>;
		const recordIds = ymeta.get('recordIds') as Y.Array<string>;
		doc.transact(() => recordIds.push([a.id]));
		expect(recordIds.toArray().filter((id) => id === a.id)).toHaveLength(2);

		deleteRecord(doc, a.id);

		expect(recordIds.toArray()).not.toContain(a.id);
		expect(ids(doc, document.id)).toEqual([b.id, c.id, d.id]);
	});

	it('reorderRecord cleans up a pre-existing duplicate and still produces a visible move (not just deleteRecord)', () => {
		const { doc, document, a, b, c, d } = setup();
		// Same leftover-duplicate state as the concurrent-move scenario above,
		// but this time a *second* reorderRecord call comes in before anything
		// cleans it up — the array still holds two entries for `a` when this
		// move is requested.
		const ymeta = doc.getMap('documents').get(document.id) as Y.Map<unknown>;
		const recordIds = ymeta.get('recordIds') as Y.Array<string>;
		doc.transact(() => recordIds.insert(2, [a.id])); // ids: a, b, a, c, d
		expect(recordIds.toArray().filter((id) => id === a.id)).toHaveLength(2);

		reorderRecord(doc, a.id, d.id); // move `a` to the very end

		expect(recordIds.toArray().filter((id) => id === a.id)).toHaveLength(1);
		expect(ids(doc, document.id)).toEqual([b.id, c.id, d.id, a.id]);
	});

	it('listRecordsForParent dedupes a duplicate id, keeping the first occurrence', () => {
		const { doc, document, a, b } = setup();
		const ymeta = doc.getMap('documents').get(document.id) as Y.Map<unknown>;
		const recordIds = ymeta.get('recordIds') as Y.Array<string>;
		doc.transact(() => recordIds.insert(1, [a.id])); // duplicate `a` right after its own slot

		const result = ids(doc, document.id);
		expect(result.filter((id) => id === a.id)).toHaveLength(1);
		expect(result.indexOf(a.id)).toBeLessThan(result.indexOf(b.id));
	});

	it('two replicas concurrently moving the same block converge to a single, deduped position with no content loss', () => {
		const { doc: docA, document, a, b, c, d } = setup();
		const docB = new Y.Doc();
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

		const ytextOnA = getRecordYText(docA, a.id)!;
		docA.transact(() => ytextOnA.insert(0, 'from A'));

		// Both replicas independently move the same block (`a`) to a different
		// position before either has seen the other's change.
		reorderRecord(docA, a.id, b.id); // A wants: b, a, c, d
		reorderRecord(docB, a.id, c.id); // B wants: b, c, a, d

		const updateFromA = Y.encodeStateAsUpdate(docA);
		const updateFromB = Y.encodeStateAsUpdate(docB);
		Y.applyUpdate(docB, updateFromA);
		Y.applyUpdate(docA, updateFromB);

		const resultA = ids(docA, document.id);
		const resultB = ids(docB, document.id);
		// Deterministic convergence: whatever position wins, both replicas agree.
		expect(resultA).toEqual(resultB);
		// No duplication and no lost siblings.
		expect(resultA.filter((id) => id === a.id)).toHaveLength(1);
		expect(new Set(resultA)).toEqual(new Set([a.id, b.id, c.id, d.id]));
		// Neither actor's content edit was lost.
		expect(
			yTextToRichText(getRecordYText(docA, a.id)!)
				.runs.map((r) => r.text)
				.join('')
		).toBe('from A');
	});
});

describe('columns: container block nesting (#148)', () => {
	function setup(columnCount?: number) {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const columns = createColumnsBlock(doc, { parentId: document.id }, human, columnCount);
		return { doc, document, columns };
	}

	it('creates a columns block with 2 columns by default, each seeded with one empty paragraph', () => {
		const { doc, columns } = setup();
		expect(columns.blockType).toBe('columns');
		expect(columns.childRecordIds).toHaveLength(2);

		for (const columnId of columns.childRecordIds!) {
			const column = getRecord(doc, columnId)!;
			expect(column.blockType).toBe('column');
			expect(column.childRecordIds).toHaveLength(1);
			const [paragraphId] = column.childRecordIds!;
			expect(getRecord(doc, paragraphId)!.blockType).toBe('paragraph');
		}
	});

	it('honors a custom columnCount', () => {
		const { columns } = setup(4);
		expect(columns.childRecordIds).toHaveLength(4);
	});

	it('parentKindOf resolves a columns/column record as "record"', () => {
		const { doc, columns } = setup();
		expect(parentKindOf(doc, columns.id)).toBe('record');
		expect(parentKindOf(doc, columns.childRecordIds![0])).toBe('record');
	});

	it('createRecord under a column adds it to that column, not the Document', () => {
		const { doc, document, columns } = setup();
		const columnId = columns.childRecordIds![0];
		const heading = createRecord(doc, { parentId: columnId, blockType: 'heading_1' }, human);

		expect(listRecordsForParent(doc, columnId).map((r) => r.id)).toContain(heading.id);
		expect(listRecordsForParent(doc, document.id).map((r) => r.id)).not.toContain(heading.id);
	});

	it('a bare create_record-style column (blockType "column") is auto-seeded with one paragraph', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const columns = createColumnsBlock(doc, { parentId: document.id }, human, 2);
		const column = createRecord(doc, { parentId: columns.id, blockType: 'column' }, human);
		expect(column.childRecordIds).toHaveLength(1);
	});

	it('reorderRecord repositions blocks within a single column', () => {
		const { doc, columns } = setup();
		const columnId = columns.childRecordIds![0];
		const [first] = getRecord(doc, columnId)!.childRecordIds!;
		const second = createRecord(doc, { parentId: columnId, blockType: 'paragraph' }, human);

		reorderRecord(doc, second.id);

		expect(listRecordsForParent(doc, columnId).map((r) => r.id)).toEqual([second.id, first]);
	});

	it('moveRecordToParent moves a block from one column into another', () => {
		const { doc, columns } = setup();
		const [columnA, columnB] = columns.childRecordIds!;
		const [blockInA] = getRecord(doc, columnA)!.childRecordIds!;

		moveRecordToParent(doc, blockInA, columnB);

		expect(listRecordsForParent(doc, columnA).map((r) => r.id)).toEqual([]);
		expect(listRecordsForParent(doc, columnB).map((r) => r.id)).toContain(blockInA);
		expect(getRecord(doc, blockInA)!.parentId).toBe(columnB);
	});

	it('moveRecordToParent supports afterRecordId to land at a specific position', () => {
		const { doc, columns } = setup();
		const [columnA, columnB] = columns.childRecordIds!;
		const [blockInA] = getRecord(doc, columnA)!.childRecordIds!;
		const [blockInB] = getRecord(doc, columnB)!.childRecordIds!;

		moveRecordToParent(doc, blockInA, columnB, blockInB);

		expect(listRecordsForParent(doc, columnB).map((r) => r.id)).toEqual([blockInB, blockInA]);
	});

	it('moveRecordToParent can move a block out of a column back to the top-level Document', () => {
		const { doc, document, columns } = setup();
		const [columnA] = columns.childRecordIds!;
		const [blockInA] = getRecord(doc, columnA)!.childRecordIds!;

		moveRecordToParent(doc, blockInA, document.id, columns.id);

		expect(listRecordsForParent(doc, document.id).map((r) => r.id)).toEqual([columns.id, blockInA]);
	});

	it('moveRecordToParent throws ValidationError when moving a record into itself', () => {
		const { doc, columns } = setup();
		expect(() => moveRecordToParent(doc, columns.id, columns.id)).toThrow(ValidationError);
	});

	it('moveRecordToParent throws ValidationError when moving a container into its own descendant', () => {
		const { doc, columns } = setup();
		const [columnA] = columns.childRecordIds!;
		expect(() => moveRecordToParent(doc, columns.id, columnA)).toThrow(ValidationError);
	});

	it('moveRecordToParent throws NotFoundError for an unknown destination parent', () => {
		const { doc, columns } = setup();
		const [columnA] = columns.childRecordIds!;
		const [blockInA] = getRecord(doc, columnA)!.childRecordIds!;
		expect(() => moveRecordToParent(doc, blockInA, 'missing')).toThrow(NotFoundError);
	});

	it('deleteRecord on a columns block recursively deletes every column and their blocks', () => {
		const { doc, document, columns } = setup();
		const [columnA, columnB] = columns.childRecordIds!;
		const [blockInA] = getRecord(doc, columnA)!.childRecordIds!;
		const [blockInB] = getRecord(doc, columnB)!.childRecordIds!;

		deleteRecord(doc, columns.id);

		expect(getRecord(doc, columns.id)).toBeUndefined();
		expect(getRecord(doc, columnA)).toBeUndefined();
		expect(getRecord(doc, columnB)).toBeUndefined();
		expect(getRecord(doc, blockInA)).toBeUndefined();
		expect(getRecord(doc, blockInB)).toBeUndefined();
		expect(listRecordsForParent(doc, document.id).map((r) => r.id)).toEqual([]);
	});

	it('deleteRecord on a single column removes only that column and its blocks, when more than the minimum remain', () => {
		const { doc, columns } = setup(3);
		const [columnA, columnB, columnC] = columns.childRecordIds!;

		deleteRecord(doc, columnA);

		expect(getRecord(doc, columnA)).toBeUndefined();
		expect(columns.childRecordIds).toContain(columnA); // stale snapshot, unaffected
		expect(getRecord(doc, columns.id)!.childRecordIds).toEqual([columnB, columnC]);
	});

	it('deleteRecord throws ValidationError when deleting a column would leave fewer than the minimum', () => {
		const { doc, columns } = setup(); // default 2 columns
		const [columnA] = columns.childRecordIds!;

		expect(() => deleteRecord(doc, columnA)).toThrow(ValidationError);
		expect(getRecord(doc, columnA)).toBeDefined(); // rejected, not partially applied
		expect(getRecord(doc, columns.id)!.childRecordIds).toHaveLength(2);
	});

	it('deleting the whole columns block is unaffected by the minimum-columns guard', () => {
		const { doc, columns } = setup(); // default 2 columns — at the minimum already
		expect(() => deleteRecord(doc, columns.id)).not.toThrow();
		expect(getRecord(doc, columns.id)).toBeUndefined();
	});

	it('createColumnsBlock rejects a columnCount outside the 2-6 range, creating nothing', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		expect(() => createColumnsBlock(doc, { parentId: document.id }, human, 1)).toThrow(
			ValidationError
		);
		expect(() => createColumnsBlock(doc, { parentId: document.id }, human, 7)).toThrow(
			ValidationError
		);
		expect(listRecordsForParent(doc, document.id)).toEqual([]);
	});

	it('createRecord rejects adding a 7th column to a columns block already at the maximum', () => {
		const { doc, columns } = setup(6);
		expect(columns.childRecordIds).toHaveLength(6);
		expect(() => createRecord(doc, { parentId: columns.id, blockType: 'column' }, human)).toThrow(
			ValidationError
		);
		expect(getRecord(doc, columns.id)!.childRecordIds).toHaveLength(6);
	});

	it('a columns/column record has no content field at all, not an empty one', () => {
		const { doc, columns } = setup();
		const [columnId] = columns.childRecordIds!;
		expect(getRecord(doc, columns.id)!.content).toBeUndefined();
		expect(getRecord(doc, columnId)!.content).toBeUndefined();
	});

	it('two replicas concurrently moving the same block to different columns converge on one authoritative location, not a ghost duplicate', () => {
		const docA = new Y.Doc();
		const document = createDocument(docA, { title: 'Notes' });
		const columns = createColumnsBlock(docA, { parentId: document.id }, human, 3);
		const [columnA, columnB, columnC] = columns.childRecordIds!;
		const [blockInA] = getRecord(docA, columnA)!.childRecordIds!;

		const docB = new Y.Doc();
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

		// Both replicas independently move the same block out of column A,
		// into two *different* destination columns, before either has seen
		// the other's change.
		moveRecordToParent(docA, blockInA, columnB);
		moveRecordToParent(docB, blockInA, columnC);

		const updateFromA = Y.encodeStateAsUpdate(docA);
		const updateFromB = Y.encodeStateAsUpdate(docB);
		Y.applyUpdate(docB, updateFromA);
		Y.applyUpdate(docA, updateFromB);

		// Both replicas converge on the same parentId (Y.Map LWW) ...
		const parentOnA = getRecord(docA, blockInA)!.parentId;
		const parentOnB = getRecord(docB, blockInA)!.parentId;
		expect(parentOnA).toBe(parentOnB);
		expect([columnB, columnC]).toContain(parentOnA);

		// ... and listRecordsForParent shows it in exactly that one column on
		// both replicas — never in the losing column, and never in both.
		const winner = parentOnA;
		const loser = winner === columnB ? columnC : columnB;
		expect(listRecordsForParent(docA, winner).map((r) => r.id)).toContain(blockInA);
		expect(listRecordsForParent(docB, winner).map((r) => r.id)).toContain(blockInA);
		expect(listRecordsForParent(docA, loser).map((r) => r.id)).not.toContain(blockInA);
		expect(listRecordsForParent(docB, loser).map((r) => r.id)).not.toContain(blockInA);
	});

	it('deleting the losing column after a concurrent cross-container move does not delete the block that now lives in the winning column', () => {
		const docA = new Y.Doc();
		const document = createDocument(docA, { title: 'Notes' });
		const columns = createColumnsBlock(docA, { parentId: document.id }, human, 3);
		const [columnA, columnB, columnC] = columns.childRecordIds!;
		const [blockInA] = getRecord(docA, columnA)!.childRecordIds!;

		const docB = new Y.Doc();
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

		moveRecordToParent(docA, blockInA, columnB);
		moveRecordToParent(docB, blockInA, columnC);
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
		Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

		const winner = getRecord(docA, blockInA)!.parentId;
		const loser = winner === columnB ? columnC : columnB;

		// The losing column's own recordIds array still has a stale entry for
		// blockInA (see isAuthoritativeChild's doc comment) — deleting that
		// column must not recurse into it and delete a block that now
		// authoritatively lives in a different, live column.
		deleteRecord(docA, loser);

		expect(getRecord(docA, blockInA)).toBeDefined();
		expect(getRecord(docA, blockInA)!.parentId).toBe(winner);
		expect(listRecordsForParent(docA, winner).map((r) => r.id)).toContain(blockInA);
	});

	it('migrating a Document after a concurrent cross-container move copies the block once, under its winning column', () => {
		const source = new Y.Doc();
		const document = createDocument(source, { title: 'Notes' });
		const columns = createColumnsBlock(source, { parentId: document.id }, human, 3);
		const [columnA, columnB, columnC] = columns.childRecordIds!;
		const [blockInA] = getRecord(source, columnA)!.childRecordIds!;

		const replica = new Y.Doc();
		Y.applyUpdate(replica, Y.encodeStateAsUpdate(source));

		moveRecordToParent(source, blockInA, columnB);
		moveRecordToParent(replica, blockInA, columnC);
		Y.applyUpdate(replica, Y.encodeStateAsUpdate(source));
		Y.applyUpdate(source, Y.encodeStateAsUpdate(replica));

		const winner = getRecord(source, blockInA)!.parentId;
		const loser = winner === columnB ? columnC : columnB;

		const target = new Y.Doc();
		copyDocumentVerbatim(source, target, document.id);

		expect(getRecord(target, blockInA)).toBeDefined();
		expect(getRecord(target, blockInA)!.parentId).toBe(winner);
		// The winning column also still has its own seeded paragraph from
		// createColumnsBlock — blockInA is an *additional* member, not the
		// only one.
		expect(listRecordsForParent(target, winner).map((r) => r.id)).toContain(blockInA);
		expect(listRecordsForParent(target, loser).map((r) => r.id)).not.toContain(blockInA);
	});
});

describe('duplicateRecord: block action menu duplicate (#152)', () => {
	it('inserts the copy immediately after the source with a fresh id', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const a = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		const b = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);

		const copy = duplicateRecord(doc, a.id, human);

		expect(copy.id).not.toBe(a.id);
		expect(listRecordsForParent(doc, document.id).map((r) => r.id)).toEqual([a.id, copy.id, b.id]);
	});

	it('copies content, blockType, and block-level fields without touching the source', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const source = createRecord(
			doc,
			{ parentId: document.id, blockType: 'to_do', checked: true },
			human
		);
		const ytext = getRecordYText(doc, source.id)!;
		doc.transact(() => ytext.insert(0, 'Buy milk'));

		const copy = duplicateRecord(doc, source.id, human);

		expect(copy.blockType).toBe('to_do');
		expect(copy.checked).toBe(true);
		expect(yTextToRichText(getRecordYText(doc, copy.id)!)).toEqual(yTextToRichText(ytext));
		// The source is untouched.
		expect(getRecord(doc, source.id)!.checked).toBe(true);
		expect(
			yTextToRichText(getRecordYText(doc, source.id)!)
				.runs.map((r) => r.text)
				.join('')
		).toBe('Buy milk');
	});

	it('copies a bookmark block’s url and bookmarkMetadata (issue #155)', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const source = createRecord(
			doc,
			{
				parentId: document.id,
				blockType: 'bookmark',
				url: 'https://example.com/',
				bookmarkMetadata: { status: 'ready', title: 'Example' }
			},
			human
		);

		const copy = duplicateRecord(doc, source.id, human);

		expect(copy.url).toBe('https://example.com/');
		expect(copy.bookmarkMetadata).toEqual({ status: 'ready', title: 'Example' });
		expect(getRecord(doc, source.id)!.url).toBe('https://example.com/');
	});

	it('stamps fresh provenance under the acting actor rather than copying the source’s', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const source = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);

		const copy = duplicateRecord(doc, source.id, agent);

		expect(copy.createdBy).toEqual(agent);
		expect(copy.lastEditedBy).toEqual(agent);
		expect(getRecord(doc, source.id)!.createdBy).toEqual(human);
	});

	it('recursively duplicates a columns block’s children with new ids, discarding the auto-seeded placeholder', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const columns = createColumnsBlock(doc, { parentId: document.id }, human, 2);
		const [columnA, columnB] = columns.childRecordIds!;
		const [seededA] = getRecord(doc, columnA)!.childRecordIds!;
		const ytext = getRecordYText(doc, seededA)!;
		doc.transact(() => ytext.insert(0, 'left column text'));

		const copy = duplicateRecord(doc, columns.id, human);

		expect(copy.id).not.toBe(columns.id);
		expect(copy.childRecordIds).toHaveLength(2);
		const [copyColumnA, copyColumnB] = copy.childRecordIds!;
		expect(copyColumnA).not.toBe(columnA);
		expect(copyColumnB).not.toBe(columnB);

		// Exactly one child in the duplicated column — the auto-seeded blank
		// paragraph createRecord adds for every new `column` was discarded, not
		// left sitting ahead of the copied real content.
		const copiedChildren = getRecord(doc, copyColumnA)!.childRecordIds!;
		expect(copiedChildren).toHaveLength(1);
		expect(copiedChildren[0]).not.toBe(seededA);
		expect(
			yTextToRichText(getRecordYText(doc, copiedChildren[0])!)
				.runs.map((r) => r.text)
				.join('')
		).toBe('left column text');

		// The original is untouched.
		expect(getRecord(doc, columnA)!.childRecordIds).toEqual([seededA]);
	});

	it('throws NotFoundError for an unknown record id', () => {
		const doc = new Y.Doc();
		expect(() => duplicateRecord(doc, 'missing', human)).toThrow(NotFoundError);
	});
});

describe('flattenDocumentBlocks: full document order for the List View outline (#152)', () => {
	it('returns top-level blocks in order with depth 0 when there is no nesting', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const a = createRecord(doc, { parentId: document.id, blockType: 'heading_1' }, human);
		const b = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);

		const flat = flattenDocumentBlocks(doc, document.id);

		expect(flat.map((f) => [f.record.id, f.depth])).toEqual([
			[a.id, 0],
			[b.id, 0]
		]);
	});

	it('walks into a columns block’s children in document order, one depth level deeper', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const before = createRecord(doc, { parentId: document.id, blockType: 'heading_1' }, human);
		const columns = createColumnsBlock(doc, { parentId: document.id }, human, 2);
		const after = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);
		const [columnA, columnB] = columns.childRecordIds!;
		const [seededA] = getRecord(doc, columnA)!.childRecordIds!;
		const [seededB] = getRecord(doc, columnB)!.childRecordIds!;

		const flat = flattenDocumentBlocks(doc, document.id);

		expect(flat.map((f) => [f.record.id, f.depth])).toEqual([
			[before.id, 0],
			[columns.id, 0],
			[columnA, 1],
			[seededA, 2],
			[columnB, 1],
			[seededB, 2],
			[after.id, 0]
		]);
	});

	it('skips a stale child-array entry left by a concurrent cross-container move', () => {
		// A single, sequential move (fork, apply the full post-move state) never
		// leaves a stale entry behind — the replica just converges to the exact
		// same recordIds arrays the source ends up with. A real stale entry only
		// exists when two replicas concurrently move the *same* block to two
		// *different* containers and are then merged (the losing container's own
		// recordIds array keeps its insert, since Y.Array has no atomic "move"
		// primitive — see moveRecordToParent's own doc comment) — the same
		// pattern the "deleting the losing column..." test above uses.
		const docA = new Y.Doc();
		const document = createDocument(docA, { title: 'Notes' });
		const columns = createColumnsBlock(docA, { parentId: document.id }, human, 3);
		const [columnA, columnB, columnC] = columns.childRecordIds!;
		const [blockInA] = getRecord(docA, columnA)!.childRecordIds!;

		const docB = new Y.Doc();
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
		moveRecordToParent(docA, blockInA, columnB);
		moveRecordToParent(docB, blockInA, columnC);
		Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
		Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));

		const winner = getRecord(docA, blockInA)!.parentId;
		const loserColumn = winner === columnB ? columnC : columnB;
		// The losing column's own *raw* recordIds array still has a stale entry
		// for blockInA (listRecordsForParent already filters it out by design —
		// see its own doc comment — so this checks the underlying Y.Array
		// directly, the only way to confirm a stale entry actually exists here).
		const loserRecordIds = (docA.getMap('records').get(loserColumn) as Y.Map<unknown>).get(
			'recordIds'
		) as Y.Array<string>;
		expect(loserRecordIds.toArray()).toContain(blockInA);

		const flat = flattenDocumentBlocks(docA, document.id);
		const occurrences = flat.filter((f) => f.record.id === blockInA);
		expect(occurrences).toHaveLength(1);
		expect(occurrences[0].record.parentId).toBe(winner);
	});
});

describe('detachSyncedBlock: issue #153 "detach to independent copy"', () => {
	it('bakes the source content and blockType into the instance and clears the reference', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const source = createRecord(doc, { parentId: document.id, blockType: 'heading_2' }, human);
		getRecordYText(doc, source.id)!.insert(0, 'Original heading');
		const instance = createRecord(
			doc,
			{ parentId: document.id, blockType: 'synced_block', referencedRecordId: source.id },
			human
		);

		const detached = detachSyncedBlock(doc, instance.id, agent);

		expect(detached.blockType).toBe('heading_2');
		expect(detached.referencedRecordId).toBeUndefined();
		expect(
			yTextToRichText(getRecordYText(doc, instance.id)!)
				.runs.map((r) => r.text)
				.join('')
		).toBe('Original heading');
		expect(detached.lastEditedBy).toEqual(agent);
		// The source itself, and its own content, are untouched by the detach.
		expect(getRecord(doc, source.id)?.blockType).toBe('heading_2');
		expect(
			yTextToRichText(getRecordYText(doc, source.id)!)
				.runs.map((r) => r.text)
				.join('')
		).toBe('Original heading');
	});

	it('copies checked/collapsed/calloutStyle state from the source', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const source = createRecord(doc, { parentId: document.id, blockType: 'to_do' }, human);
		setRecordChecked(doc, source.id, true, human);
		const instance = createRecord(
			doc,
			{ parentId: document.id, blockType: 'synced_block', referencedRecordId: source.id },
			human
		);

		const detached = detachSyncedBlock(doc, instance.id, human);

		expect(detached.blockType).toBe('to_do');
		expect(detached.checked).toBe(true);
	});

	it('detaches to an empty paragraph when the reference is already broken', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const instance = createRecord(
			doc,
			{
				parentId: document.id,
				blockType: 'synced_block',
				referencedRecordId: 'never-existed'
			},
			human
		);

		const detached = detachSyncedBlock(doc, instance.id, human);

		expect(detached.blockType).toBe('paragraph');
		expect(detached.referencedRecordId).toBeUndefined();
	});

	it('detaches to an empty paragraph when no target was ever set', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const instance = createRecord(doc, { parentId: document.id, blockType: 'synced_block' }, human);

		const detached = detachSyncedBlock(doc, instance.id, human);

		expect(detached.blockType).toBe('paragraph');
	});

	it('throws when called on a non-synced_block record', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const paragraph = createRecord(doc, { parentId: document.id, blockType: 'paragraph' }, human);

		expect(() => detachSyncedBlock(doc, paragraph.id, human)).toThrow(ValidationError);
	});

	it('throws NotFoundError for an unknown record id', () => {
		const doc = new Y.Doc();
		createDocument(doc, { title: 'Notes' });

		expect(() => detachSyncedBlock(doc, 'missing', human)).toThrow(NotFoundError);
	});

	// CodeRabbit finding (PR #244): the "Set target ID" dialog accepts any
	// pasted record id with no kind check, so a synced_block can end up
	// pointing at a columns/column container — copying that blockType as-is
	// would produce a broken container with no childRecordIds.
	it('detaches to an empty paragraph rather than copying a columns/column container source', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const columns = createColumnsBlock(doc, { parentId: document.id }, human);
		const instance = createRecord(
			doc,
			{ parentId: document.id, blockType: 'synced_block', referencedRecordId: columns.id },
			human
		);

		const detached = detachSyncedBlock(doc, instance.id, human);

		expect(detached.blockType).toBe('paragraph');
		expect(detached.referencedRecordId).toBeUndefined();
		expect(detached.childRecordIds).toBeUndefined();
	});

	// CodeRabbit finding (PR #244): a page_link/collection_view/child_pages
	// source's own referencedRecordId/viewConfig is configuration, not just
	// content — copying only blockType/text previously produced an
	// unconfigured block of that type (a page_link with no target, etc.).
	it('copies referencedRecordId when the source is a page_link', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const target = createDocument(doc, { title: 'Target' });
		const source = createRecord(
			doc,
			{ parentId: document.id, blockType: 'page_link', referencedRecordId: target.id },
			human
		);
		const instance = createRecord(
			doc,
			{ parentId: document.id, blockType: 'synced_block', referencedRecordId: source.id },
			human
		);

		const detached = detachSyncedBlock(doc, instance.id, human);

		expect(detached.blockType).toBe('page_link');
		expect(detached.referencedRecordId).toBe(target.id);
	});

	it('copies referencedRecordId and viewConfig when the source is a collection_view', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const collection = createCollection(doc, { title: 'Tasks', schema: [] });
		const source = createRecord(
			doc,
			{
				parentId: document.id,
				blockType: 'collection_view',
				referencedRecordId: collection.id,
				viewConfig: { viewType: 'table' }
			},
			human
		);
		const instance = createRecord(
			doc,
			{ parentId: document.id, blockType: 'synced_block', referencedRecordId: source.id },
			human
		);

		const detached = detachSyncedBlock(doc, instance.id, human);

		expect(detached.blockType).toBe('collection_view');
		expect(detached.referencedRecordId).toBe(collection.id);
		expect(detached.viewConfig?.viewType).toBe('table');
	});

	it('copies url and bookmarkMetadata when the source is a bookmark (issue #155)', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const source = createRecord(
			doc,
			{
				parentId: document.id,
				blockType: 'bookmark',
				url: 'https://example.com/',
				bookmarkMetadata: { status: 'ready', title: 'Example' }
			},
			human
		);
		const instance = createRecord(
			doc,
			{ parentId: document.id, blockType: 'synced_block', referencedRecordId: source.id },
			human
		);

		const detached = detachSyncedBlock(doc, instance.id, human);

		expect(detached.blockType).toBe('bookmark');
		expect(detached.url).toBe('https://example.com/');
		expect(detached.bookmarkMetadata).toEqual({ status: 'ready', title: 'Example' });
	});

	// CodeRabbit finding (PR #244): a synced_block can (unusually) point at
	// another synced_block — copying that wrapper's own blockType/empty
	// content as-is would just produce a second unconfigured synced_block
	// instead of the real independent content detach is supposed to produce.
	it('resolves through a chain of synced_block references to the real content', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const root = createRecord(doc, { parentId: document.id, blockType: 'heading_2' }, human);
		getRecordYText(doc, root.id)!.insert(0, 'Root content');
		const middle = createRecord(
			doc,
			{ parentId: document.id, blockType: 'synced_block', referencedRecordId: root.id },
			human
		);
		const instance = createRecord(
			doc,
			{ parentId: document.id, blockType: 'synced_block', referencedRecordId: middle.id },
			human
		);

		const detached = detachSyncedBlock(doc, instance.id, human);

		expect(detached.blockType).toBe('heading_2');
		expect(
			yTextToRichText(getRecordYText(doc, instance.id)!)
				.runs.map((r) => r.text)
				.join('')
		).toBe('Root content');
	});

	it('detaches to an empty paragraph rather than infinite-looping on a synced_block reference cycle', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Notes' });
		const a = createRecord(doc, { parentId: document.id, blockType: 'synced_block' }, human);
		const b = createRecord(
			doc,
			{ parentId: document.id, blockType: 'synced_block', referencedRecordId: a.id },
			human
		);
		setRecordReferencedId(doc, a.id, b.id, human);

		const detached = detachSyncedBlock(doc, a.id, human);

		expect(detached.blockType).toBe('paragraph');
		expect(detached.referencedRecordId).toBeUndefined();
	});
});
