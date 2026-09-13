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
	sanitizeFilename
} from './export';
import type { CallerIdentity } from './permissions';

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

		// Unzip using fflate unzipSync
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
			outputDir: tempDir
		});

		expect(updated.enabled).toBe(true);
		expect(updated.outputDir).toBe(tempDir);

		const reloaded = getMirrorConfig();
		expect(reloaded.enabled).toBe(true);
		expect(reloaded.outputDir).toBe(tempDir);
	});

	it('syncs workspace content to the Markdown mirror directory when enabled', () => {
		updateMirrorConfig(caller, {
			enabled: true,
			outputDir: tempDir
		});

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
	});
});
