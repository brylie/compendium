import { describe, expect, it } from 'vitest';
import {
	createCollection,
	createDocument,
	createRecord,
	searchWorkspace,
	writeRecord
} from './index';
import {
	createCollection as rawCrdtCreateCollection,
	createDocument as rawCrdtCreateDocument,
	createRecord as rawCrdtCreateRecord
} from '$lib/data/records';
import { TEST_ORIGIN, transactWithOrigin } from '$lib/mutation-origin';
import { createToken } from '$lib/mcp/tokens';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import type { ActorId } from '$lib/data/types';

const human: ActorId = { kind: 'human', userId: 'brylie' };

function crdtCreateDocument(...args: Parameters<typeof rawCrdtCreateDocument>) {
	return transactWithOrigin(args[0], TEST_ORIGIN, () => rawCrdtCreateDocument(...args));
}

function crdtCreateCollection(...args: Parameters<typeof rawCrdtCreateCollection>) {
	return transactWithOrigin(args[0], TEST_ORIGIN, () => rawCrdtCreateCollection(...args));
}

function crdtCreateRecord(...args: Parameters<typeof rawCrdtCreateRecord>) {
	return transactWithOrigin(args[0], TEST_ORIGIN, () => rawCrdtCreateRecord(...args));
}

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

describe('searchWorkspace: token scoping', () => {
	it('skips a catalog-listed collection a token has no grant for', () => {
		const collection = createCollection(human, {
			title: 'Token Denied Catalog',
			schema: [{ key: 'summary', label: 'Summary', type: 'text' }]
		});
		const row = createRecord(human, {
			parentId: collection.id,
			properties: { summary: { type: 'text', value: 'gamma keyword' } }
		});
		const { record: token } = createToken({
			clientLabel: 'Search Test Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});

		const results = searchWorkspace(token, 'gamma');
		expect(results.some((r) => r.recordId === row.id)).toBe(false);
	});

	it('finds a row in a catalog-listed collection the token is granted', () => {
		const collection = createCollection(human, {
			title: 'Token Granted Catalog',
			schema: [{ key: 'summary', label: 'Summary', type: 'text' }]
		});
		const row = createRecord(human, {
			parentId: collection.id,
			properties: { summary: { type: 'text', value: 'delta keyword' } }
		});
		const { record: token } = createToken({
			clientLabel: 'Search Test Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: [collection.id]
		});

		const results = searchWorkspace(token, 'delta');
		expect(results.some((r) => r.recordId === row.id)).toBe(true);
	});

	it('skips an uncataloged collection a token has no grant for', () => {
		const { doc } = resolveWorkspaceContext();
		const uncataloged = crdtCreateCollection(doc, {
			title: 'Uncataloged',
			schema: [{ key: 'summary', label: 'Summary', type: 'text' }]
		});
		const row = createRecord(human, {
			parentId: uncataloged.id,
			properties: { summary: { type: 'text', value: 'epsilon keyword' } }
		});
		const { record: token } = createToken({
			clientLabel: 'Search Test Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});

		const results = searchWorkspace(token, 'epsilon');
		expect(results.some((r) => r.recordId === row.id)).toBe(false);
	});

	it('skips an uncataloged document a token has no grant for', () => {
		const { doc } = resolveWorkspaceContext();
		const uncatalogedDoc = crdtCreateDocument(doc, { title: 'Uncataloged Doc' });
		const block = crdtCreateRecord(
			doc,
			{ parentId: uncatalogedDoc.id, blockType: 'paragraph' },
			human
		);
		writeRecord(human, block.id, { markdown: 'eta keyword' });
		const { record: token } = createToken({
			clientLabel: 'Search Test Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});

		const results = searchWorkspace(token, 'eta');
		expect(results.some((r) => r.recordId === block.id)).toBe(false);
	});

	it('finds a row in an uncataloged collection the token is granted', () => {
		const { doc } = resolveWorkspaceContext();
		const uncataloged = crdtCreateCollection(doc, {
			title: 'Uncataloged Granted',
			schema: [{ key: 'summary', label: 'Summary', type: 'text' }]
		});
		const row = createRecord(human, {
			parentId: uncataloged.id,
			properties: { summary: { type: 'text', value: 'zeta keyword' } }
		});
		const { record: token } = createToken({
			clientLabel: 'Search Test Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: [uncataloged.id]
		});

		const results = searchWorkspace(token, 'zeta');
		expect(results.some((r) => r.recordId === row.id)).toBe(true);
	});

	// Regression coverage for a CodeRabbit finding on #170/#172: uncataloged
	// content (no locator row) has no resolved spaceId, so it was being
	// classified as "no Space" rather than the default Space — a token
	// relying solely on a default-Space grant (not a per-id grant) was
	// silently denied every uncataloged Document/Collection, in both search
	// and getDocument's page_link/collection_view resolution.
	it('finds a row in an uncataloged collection via a default-Space-only grant (no per-id grant)', () => {
		const { doc, defaultSpaceId } = resolveWorkspaceContext();
		const uncataloged = crdtCreateCollection(doc, {
			title: 'Uncataloged Space-Granted',
			schema: [{ key: 'summary', label: 'Summary', type: 'text' }]
		});
		const row = createRecord(human, {
			parentId: uncataloged.id,
			properties: { summary: { type: 'text', value: 'theta keyword' } }
		});
		const { record: token } = createToken({
			clientLabel: 'Search Test Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: [],
			allowedSpaceIds: [defaultSpaceId]
		});

		const results = searchWorkspace(token, 'theta');
		expect(results.some((r) => r.recordId === row.id)).toBe(true);
	});

	it('finds a block in an uncataloged document via a default-Space-only grant (no per-id grant)', () => {
		const { doc, defaultSpaceId } = resolveWorkspaceContext();
		const uncataloged = crdtCreateDocument(doc, { title: 'Uncataloged Doc Space-Granted' });
		const block = crdtCreateRecord(
			doc,
			{ parentId: uncataloged.id, blockType: 'paragraph' },
			human
		);
		writeRecord(human, block.id, { markdown: 'iota keyword' });
		const { record: token } = createToken({
			clientLabel: 'Search Test Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: [],
			allowedSpaceIds: [defaultSpaceId]
		});

		const results = searchWorkspace(token, 'iota');
		expect(results.some((r) => r.recordId === block.id)).toBe(true);
	});
});
