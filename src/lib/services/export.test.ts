import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { unzipSync, strFromU8 } from 'fflate';
import { createDocument } from './documents';
import { createCollection } from './collections';
import { createRecord, writeRecord } from './records';
import {
	exportDocument,
	exportCollection,
	exportWorkspace,
	getMirrorConfig,
	updateMirrorConfig,
	syncMarkdownMirror,
	sanitizeFilename,
	renderBlockMarkdown,
	collectionRecordsToCsv,
	collectionToMarkdownTable
} from './export';
import type { CallerIdentity } from './permissions';
import type { DocumentRecordView } from './document-projection';
import type { PropertyDefinition, WorkspaceRecord } from '$lib/data/types';

describe('export service', () => {
	const caller: CallerIdentity = { kind: 'human', userId: 'test-user' };
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compendium-export-test-'));
	});

	afterEach(() => {
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('sanitizes filenames safely across platforms', () => {
		expect(sanitizeFilename('Normal Title')).toBe('Normal Title');
		expect(sanitizeFilename('Title / With \\ Special : Chars?')).toBe(
			'Title _ With _ Special _ Chars_'
		);
		expect(sanitizeFilename('   ')).toBe('Untitled');
	});

	it('renders block markdown for all supported block types', () => {
		const blocks: { input: DocumentRecordView; expected: string }[] = [
			{
				input: { id: '1', blockType: 'heading_1', markdown: 'Heading 1' },
				expected: '# Heading 1'
			},
			{
				input: { id: '2', blockType: 'heading_2', markdown: 'Heading 2' },
				expected: '## Heading 2'
			},
			{
				input: { id: '3', blockType: 'heading_3', markdown: 'Heading 3' },
				expected: '### Heading 3'
			},
			{
				input: { id: '4', blockType: 'heading_4', markdown: 'Heading 4' },
				expected: '#### Heading 4'
			},
			{
				input: { id: '5', blockType: 'bulleted_list_item', markdown: 'Bullet' },
				expected: '- Bullet'
			},
			{
				input: { id: '6', blockType: 'numbered_list_item', markdown: 'Number' },
				expected: '1. Number'
			},
			{
				input: { id: '7', blockType: 'to_do', checked: true, markdown: 'Task done' },
				expected: '- [x] Task done'
			},
			{
				input: { id: '8', blockType: 'to_do', checked: false, markdown: 'Task pending' },
				expected: '- [ ] Task pending'
			},
			{ input: { id: '9', blockType: 'quote', markdown: 'A quote' }, expected: '> A quote' },
			{
				input: { id: '10', blockType: 'code', markdown: 'const x = 1;' },
				expected: '```\nconst x = 1;\n```'
			},
			{ input: { id: '11', blockType: 'divider', markdown: '' }, expected: '---' },
			{
				input: { id: '12', blockType: 'paragraph', markdown: 'Plain text' },
				expected: 'Plain text'
			}
		];

		for (const b of blocks) {
			expect(renderBlockMarkdown(b.input)).toBe(b.expected);
		}
	});

	it('renders CSV and Markdown tables for collection records across property types', () => {
		const schema: PropertyDefinition[] = [
			{ key: 'name', label: 'Item Name', type: 'text' },
			{ key: 'cost', label: 'Price', type: 'number' },
			{ key: 'available', label: 'In Stock', type: 'checkbox' },
			{ key: 'dateAdded', label: 'Date', type: 'date' },
			{ key: 'tags', label: 'Tags', type: 'select' },
			{ key: 'related', label: 'Related Items', type: 'relation' },
			{ key: 'unknownProp', label: 'Other', type: 'text' }
		];

		const records: WorkspaceRecord[] = [
			{
				id: 'rec-1',
				parentId: 'col-1',
				recordType: 'collection_item',
				order: 'a0',
				properties: {
					name: { type: 'text', value: 'Widget, Special "Edition"\nLine 2' },
					cost: { type: 'number', value: 19.99 },
					available: { type: 'checkbox', value: true },
					dateAdded: { type: 'date', value: '2026-09-13' },
					tags: { type: 'select', value: 'Gadgets' },
					related: { type: 'relation', value: ['rec-2', 'rec-3'] }
				}
			},
			{
				id: 'rec-2',
				parentId: 'col-1',
				recordType: 'collection_item',
				order: 'a1',
				properties: {
					name: { type: 'text', value: 'Simple Item' },
					available: { type: 'checkbox', value: false }
				}
			}
		];

		const csv = collectionRecordsToCsv(schema, records);
		expect(csv).toContain('id,Item Name,Price,In Stock,Date,Tags,Related Items,Other');
		expect(csv).toContain('"Widget, Special ""Edition""\nLine 2"');
		expect(csv).toContain('19.99,true,2026-09-13,Gadgets,"rec-2, rec-3"');
		expect(csv).toContain('rec-2,Simple Item,,,false,,,');

		const mdTable = collectionToMarkdownTable('Inventory', schema, records);
		expect(mdTable).toContain('# Inventory');
		expect(mdTable).toContain(
			'| ID | Item Name | Price | In Stock | Date | Tags | Related Items | Other |'
		);
		expect(mdTable).toContain('Widget, Special "Edition"');
		expect(mdTable).toContain('✓');
	});

	it('exports a single Document as Markdown', () => {
		const doc = createDocument(caller, { title: 'Test Export Document' });
		const block = createRecord(caller, {
			parentId: doc.id,
			blockType: 'paragraph'
		});
		writeRecord(caller, block.id, { markdown: 'Hello world' });

		const exported = exportDocument(caller, doc.id);
		expect(exported.title).toBe('Test Export Document');
		expect(exported.markdown).toContain('# Test Export Document');
		expect(exported.markdown).toContain('Hello world');
		expect(exported.files).toHaveLength(1);
		expect(exported.files[0].path).toBe('Test Export Document.md');
	});

	it('exports a Collection to CSV, JSON, and Markdown table', () => {
		const col = createCollection(caller, {
			title: 'Task List',
			schema: [
				{ key: 'title', label: 'Title', type: 'text' },
				{ key: 'done', label: 'Done', type: 'checkbox' }
			]
		});

		createRecord(caller, {
			parentId: col.id,
			properties: {
				title: { type: 'text', value: 'Buy groceries' },
				done: { type: 'checkbox', value: true }
			}
		});

		const exported = exportCollection(caller, col.id);
		expect(exported.collection.title).toBe('Task List');
		expect(exported.schemaJson).toContain('"label": "Title"');
		expect(exported.recordsJson).toContain('Buy groceries');
		expect(exported.recordsCsv).toContain('id,Title,Done');
		expect(exported.recordsCsv).toContain('Buy groceries,true');
		expect(exported.markdownTable).toContain('| ID | Title | Done |');
	});

	it('exports a full Workspace bundle with manifest.json and a valid ZIP buffer', () => {
		const doc1 = createDocument(caller, { title: 'First Document' });
		const block = createRecord(caller, {
			parentId: doc1.id,
			blockType: 'heading_1'
		});
		writeRecord(caller, block.id, { markdown: 'Welcome' });

		const col1 = createCollection(caller, { title: 'Projects' });

		const result = exportWorkspace(caller);
		expect(result.manifest.version).toBe('1.0');
		expect(result.manifest.documents.some((d) => d.id === doc1.id)).toBe(true);
		expect(result.manifest.collections.some((c) => c.id === col1.id)).toBe(true);

		const unzipped = unzipSync(result.zipBuffer);
		expect(unzipped['manifest.json']).toBeDefined();

		const manifestStr = strFromU8(unzipped['manifest.json']);
		expect(manifestStr).toContain('First Document');
	});

	it('updates and reads mirror configuration', () => {
		const initial = getMirrorConfig();
		expect(typeof initial.enabled).toBe('boolean');

		const updated = updateMirrorConfig(caller, {
			enabled: true,
			outputDir: tempDir,
			syncIntervalMs: 30000
		});

		expect(updated.enabled).toBe(true);
		expect(updated.outputDir).toBe(tempDir);
		expect(updated.syncIntervalMs).toBe(30000);

		const reloaded = getMirrorConfig();
		expect(reloaded.enabled).toBe(true);
		expect(reloaded.outputDir).toBe(tempDir);
		expect(reloaded.syncIntervalMs).toBe(30000);
	});

	it('syncs workspace content and cleans stale files in mirror directory', () => {
		updateMirrorConfig(caller, {
			enabled: true,
			outputDir: tempDir
		});

		const staleFilePath = path.join(tempDir, 'documents', 'Old Stale File.md');
		fs.mkdirSync(path.dirname(staleFilePath), { recursive: true });
		fs.writeFileSync(staleFilePath, 'old content', 'utf-8');

		const doc = createDocument(caller, { title: 'Mirrored Doc' });
		const block = createRecord(caller, {
			parentId: doc.id,
			blockType: 'paragraph'
		});
		writeRecord(caller, block.id, { markdown: 'Mirror content' });

		const syncResult = syncMarkdownMirror();
		expect(syncResult.synced).toBe(true);
		expect(syncResult.outputDir).toBe(tempDir);

		const manifestPath = path.join(tempDir, 'manifest.json');
		expect(fs.existsSync(manifestPath)).toBe(true);

		const docPath = path.join(tempDir, 'documents', 'Mirrored Doc.md');
		expect(fs.existsSync(docPath)).toBe(true);
		const content = fs.readFileSync(docPath, 'utf-8');
		expect(content).toContain('Mirror content');

		// Stale file should have been cleaned up
		expect(fs.existsSync(staleFilePath)).toBe(false);
	});
});
