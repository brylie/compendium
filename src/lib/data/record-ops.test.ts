import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DEFAULT_CUSTOM_CALLOUT_COLOR } from './callout-style';
import { createDocument, listDocuments } from './document-ops';
import { createCollection, listCollections } from './collection-ops';
import {
	createRecord,
	deleteRecord,
	getRecord,
	getRecordYText,
	listRecordsForParent,
	patchRecordViewConfig,
	reorderRecord,
	setBlockType,
	setRecordCalloutStyle,
	setRecordChecked,
	setRecordCollapsed,
	setRecordReferencedId,
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
