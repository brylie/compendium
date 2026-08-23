import { describe, expect, it } from 'vitest';
import {
	createCollection,
	createDocument,
	createRecord,
	searchWorkspace,
	writeRecord
} from './index';
import type { ActorId } from '$lib/data/types';

const human: ActorId = { kind: 'human', userId: 'brylie' };

describe('searchWorkspace: snippet boundaries', () => {
	it('omits the leading ellipsis when the match is at the very start of the text', () => {
		const doc = createDocument(human, { title: 'Snippet Doc', createInitialBlock: true });
		const block = createRecord(human, { parentId: doc.id, blockType: 'paragraph' });
		writeRecord(human, block.id, { markdown: `needle ${'x'.repeat(100)}` });

		const results = searchWorkspace(human, 'needle');
		const match = results.find((r) => r.recordId === block.id);
		expect(match?.snippet.startsWith('…')).toBe(false);
		expect(match?.snippet.endsWith('…')).toBe(true);
	});

	it('omits the trailing ellipsis when the match runs to the end of the text', () => {
		const doc = createDocument(human, { title: 'Snippet Doc 2', createInitialBlock: true });
		const block = createRecord(human, { parentId: doc.id, blockType: 'paragraph' });
		writeRecord(human, block.id, { markdown: `${'y'.repeat(100)} needle` });

		const results = searchWorkspace(human, 'needle');
		const match = results.find((r) => r.recordId === block.id);
		expect(match?.snippet.startsWith('…')).toBe(true);
		expect(match?.snippet.endsWith('…')).toBe(false);
	});
});

describe('searchWorkspace: collection row properties', () => {
	it('matches a select property and skips non-text/select properties ahead of it', () => {
		const collection = createCollection(human, {
			title: 'Tasks',
			schema: [
				{ key: 'priority', label: 'Priority', type: 'number' },
				{ key: 'status', label: 'Status', type: 'select' }
			]
		});
		const row = createRecord(human, {
			parentId: collection.id,
			properties: {
				priority: { type: 'number', value: 3 },
				status: { type: 'select', value: 'blocked-alpha' }
			}
		});

		const results = searchWorkspace(human, 'alpha');
		expect(results.some((r) => r.recordId === row.id)).toBe(true);
	});

	it('matches a text property value', () => {
		const collection = createCollection(human, {
			title: 'Notes',
			schema: [{ key: 'summary', label: 'Summary', type: 'text' }]
		});
		const row = createRecord(human, {
			parentId: collection.id,
			properties: { summary: { type: 'text', value: 'contains beta keyword' } }
		});

		const results = searchWorkspace(human, 'beta');
		expect(results.some((r) => r.recordId === row.id)).toBe(true);
	});

	it('does not match a row with no text/select property containing the query', () => {
		const collection = createCollection(human, {
			title: 'Numbers',
			schema: [{ key: 'count', label: 'Count', type: 'number' }]
		});
		const row = createRecord(human, {
			parentId: collection.id,
			properties: { count: { type: 'number', value: 42 } }
		});

		const results = searchWorkspace(human, '42');
		expect(results.some((r) => r.recordId === row.id)).toBe(false);
	});
});
