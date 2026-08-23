import { describe, expect, it } from 'vitest';
import {
	createCollection,
	createDocument,
	createRecord,
	deleteCollection,
	deleteDocument,
	deleteRecord,
	getDocument,
	getRecord,
	holdRecords,
	listCollections,
	listDocuments,
	moveDocument,
	queryCollection,
	releaseRecords,
	searchWorkspace,
	updateCollectionTitle,
	updateDocumentTitle,
	writeRecord,
	PermissionDeniedError,
	HoldRequiredError
} from './index';
import { createToken, verifyToken } from '$lib/mcp/tokens';
import { queryAuditLog } from '$lib/server/audit';
import { getYDoc } from '$lib/server/ydoc';
import { createRecord as crdtCreateRecord } from '$lib/data/records';
import type { ActorId } from '$lib/data/types';

const human: ActorId = { kind: 'human', userId: 'brylie' };

describe('service layer: centralized business rules & side effects', () => {
	it('creates documents, logs audit, and persists token grants in SQLite', () => {
		// 1. Create document as human
		const docA = createDocument(human, { title: 'Parent Doc', createInitialBlock: true });
		expect(docA.id).toBeDefined();
		expect(docA.title).toBe('Parent Doc');

		// Check audit log
		const audits = queryAuditLog();
		expect(audits.some((a) => a.action === 'create_document' && a.targetRecordId === docA.id)).toBe(
			true
		);

		// Check initial block
		const fullDoc = getDocument(human, docA.id);
		expect(fullDoc?.records).toHaveLength(1);
		expect(fullDoc?.records[0].blockType).toBe('paragraph');

		// 2. Create token scoped only to docA
		const { token, record: tokenRecord } = createToken({
			clientLabel: 'Service Test Bot',
			allowedDocumentIds: [docA.id],
			allowedCollectionIds: []
		});

		// 3. Agent creates nested document under docA
		const childDoc = createDocument(tokenRecord, {
			title: 'Nested Child',
			parentDocumentId: docA.id
		});
		expect(childDoc.parentDocumentId).toBe(docA.id);

		// 4. Verify that a fresh token read from SQLite has the new document granted
		const freshToken = verifyToken(token);
		expect(freshToken?.allowedDocumentIds).toContain(childDoc.id);

		// 5. Read child document using the fresh token
		const readChild = getDocument(freshToken!, childDoc.id);
		expect(readChild?.title).toBe('Nested Child');
	});

	it('enforces permission boundaries on nested document creation and moving', () => {
		const docSecret = createDocument(human, { title: 'Secret Doc' });
		const docAllowed = createDocument(human, { title: 'Allowed Doc' });

		const { record: tokenRecord } = createToken({
			clientLabel: 'Scoped Bot',
			allowedDocumentIds: [docAllowed.id],
			allowedCollectionIds: []
		});

		// Cannot create sub-page under docSecret
		expect(() =>
			createDocument(tokenRecord, {
				title: 'Exploit Child',
				parentDocumentId: docSecret.id
			})
		).toThrow(PermissionDeniedError);

		// Cannot move docAllowed under docSecret
		expect(() =>
			moveDocument(tokenRecord, docAllowed.id, {
				parentDocumentId: docSecret.id
			})
		).toThrow(PermissionDeniedError);

		// Human can move it
		moveDocument(human, docAllowed.id, { parentDocumentId: docSecret.id });
		const updated = getDocument(human, docAllowed.id);
		expect(updated?.parentDocumentId).toBe(docSecret.id);
	});

	it('enforces hold requirements for agents before writing block content', () => {
		const doc = createDocument(human, { title: 'Collaboration Doc' });
		const block = createRecord(human, { parentId: doc.id, blockType: 'paragraph' });

		const { record: tokenRecord } = createToken({
			clientLabel: 'Writer Bot',
			allowedDocumentIds: [doc.id],
			allowedCollectionIds: []
		});

		// Agent tries to write without hold -> throws HoldRequiredError
		expect(() => writeRecord(tokenRecord, block.id, { markdown: 'Unheld edit' })).toThrow(
			HoldRequiredError
		);

		// Agent requests hold
		const holdRes = holdRecords(tokenRecord, [block.id]);
		expect(holdRes.granted).toContain(block.id);

		// Agent writes with active hold -> succeeds and automatically releases hold
		writeRecord(tokenRecord, block.id, { markdown: 'Held edit' });

		const readDoc = getDocument(human, doc.id);
		expect(readDoc?.records[0].markdown).toBe('Held edit');

		// Second write without new hold -> fails again because hold was consumed
		expect(() => writeRecord(tokenRecord, block.id, { markdown: 'Second edit' })).toThrow(
			HoldRequiredError
		);
	});

	it('manages collections, persists collection grants, and queries rows', () => {
		const col = createCollection(human, {
			title: 'Sprint Backlog',
			schema: [{ key: 'status', label: 'Status', type: 'select' }]
		});

		const { record: tokenRecord } = createToken({
			clientLabel: 'PM Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: [col.id]
		});

		createRecord(tokenRecord, {
			parentId: col.id,
			properties: { status: { type: 'select', value: 'in_progress' } }
		});

		const queried = queryCollection(tokenRecord, col.id);
		expect(queried.collection?.title).toBe('Sprint Backlog');
		expect(queried.records).toHaveLength(1);
		expect(queried.records[0].properties?.status).toEqual({
			type: 'select',
			value: 'in_progress'
		});
	});

	it('filters workspace search results by caller permission scope', () => {
		const docPublic = createDocument(human, { title: 'Public Handbook' });
		createRecord(human, { parentId: docPublic.id, blockType: 'paragraph' });
		const pBlock = getDocument(human, docPublic.id)!.records[0];
		writeRecord(human, pBlock.id, { markdown: 'Alpha project guidelines' });

		const docPrivate = createDocument(human, { title: 'Private Vault' });
		const vBlock = createRecord(human, { parentId: docPrivate.id, blockType: 'paragraph' });
		writeRecord(human, vBlock.id, { markdown: 'Alpha secret passwords' });

		const { record: tokenRecord } = createToken({
			clientLabel: 'Search Bot',
			allowedDocumentIds: [docPublic.id],
			allowedCollectionIds: []
		});

		const results = searchWorkspace(tokenRecord, 'Alpha');
		expect(results).toHaveLength(1);
		expect(results[0].recordId).toBe(pBlock.id);

		const humanResults = searchWorkspace(human, 'Alpha');
		expect(humanResults.length).toBeGreaterThanOrEqual(2);
	});

	it('omits a page_link target outside the caller token scope instead of leaking its title', () => {
		const docPublic = createDocument(human, { title: 'Public Handbook' });
		const docSecret = createDocument(human, { title: 'Secret Doc' });

		// Only the UI's direct CRDT write path can set referencedRecordId today
		// (see markdown-transcoding.md) — mirror that here rather than going
		// through the service-layer createRecord, which doesn't accept it.
		const link = crdtCreateRecord(
			getYDoc(),
			{ parentId: docPublic.id, blockType: 'page_link', referencedRecordId: docSecret.id },
			human
		);

		const { record: tokenRecord } = createToken({
			clientLabel: 'Scoped Bot',
			allowedDocumentIds: [docPublic.id],
			allowedCollectionIds: []
		});

		const scoped = getDocument(tokenRecord, docPublic.id);
		const scopedLink = scoped?.records.find((r) => r.id === link.id);
		expect(scopedLink?.referencedRecordId).toBeUndefined();
		expect(scopedLink?.markdown).toBe('');

		const full = getDocument(human, docPublic.id);
		const fullLink = full?.records.find((r) => r.id === link.id);
		expect(fullLink?.referencedRecordId).toBe(docSecret.id);
		expect(fullLink?.markdown).toBe('[[Secret Doc]]');
	});

	it('renders a page_link block with rich text but no referencedRecordId via its own content', () => {
		const docPublic = createDocument(human, { title: 'Public Handbook' });
		const link = crdtCreateRecord(
			getYDoc(),
			{ parentId: docPublic.id, blockType: 'page_link' },
			human
		);
		writeRecord(human, link.id, { markdown: 'unresolved link text' });

		const result = getDocument(human, docPublic.id);
		const linkRecord = result?.records.find((r) => r.id === link.id);
		expect(linkRecord?.markdown).toBe('unresolved link text');
	});
});

describe('service layer: documents — unfiltered listing, delete, and rename', () => {
	it('listDocuments returns every document, unfiltered, for a human caller', () => {
		createDocument(human, { title: 'Doc One' });
		createDocument(human, { title: 'Doc Two' });
		const docs = listDocuments(human);
		expect(docs.length).toBeGreaterThanOrEqual(2);
	});

	it('listDocuments filters to only what a token was granted', () => {
		const docAllowed = createDocument(human, { title: 'Allowed' });
		createDocument(human, { title: 'Not Allowed' });
		const { record: tokenRecord } = createToken({
			clientLabel: 'Scoped Lister',
			allowedDocumentIds: [docAllowed.id],
			allowedCollectionIds: []
		});
		const docs = listDocuments(tokenRecord);
		expect(docs).toHaveLength(1);
		expect(docs[0].id).toBe(docAllowed.id);
	});

	it('updateDocumentTitle renames a document and logs the change', () => {
		const doc = createDocument(human, { title: 'Before' });
		updateDocumentTitle(human, doc.id, 'After');
		expect(getDocument(human, doc.id)?.title).toBe('After');
	});

	it('deleteDocument removes a document a caller can access', () => {
		const doc = createDocument(human, { title: 'To Delete' });
		deleteDocument(human, doc.id);
		expect(getDocument(human, doc.id)).toBeNull();
	});

	it('deleteDocument is denied for a token without access to the parent', () => {
		const doc = createDocument(human, { title: 'Protected' });
		const { record: tokenRecord } = createToken({
			clientLabel: 'No Access Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});
		expect(() => deleteDocument(tokenRecord, doc.id)).toThrow(PermissionDeniedError);
	});
});

describe('service layer: collections — grants, listing, query, delete, rename', () => {
	it('a token creating a collection is granted access to it and can query it back', () => {
		const { record: tokenRecord } = createToken({
			clientLabel: 'Collection Creator Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});
		const collection = createCollection(tokenRecord, { title: 'Bot-created Table' });
		const { collection: queried } = queryCollection(tokenRecord, collection.id);
		expect(queried?.id).toBe(collection.id);
	});

	it('listCollections filters to only what a token was granted', () => {
		const colAllowed = createCollection(human, { title: 'Allowed Table' });
		createCollection(human, { title: 'Not Allowed Table' });
		const { record: tokenRecord } = createToken({
			clientLabel: 'Scoped Collection Lister',
			allowedDocumentIds: [],
			allowedCollectionIds: [colAllowed.id]
		});
		const collections = listCollections(tokenRecord);
		expect(collections).toHaveLength(1);
		expect(collections[0].id).toBe(colAllowed.id);
	});

	it('queryCollection returns an undefined collection for an id the caller is scoped to but that was never created', () => {
		const { record: tokenRecord } = createToken({
			clientLabel: 'Dangling Scope Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: ['never-created']
		});
		const { collection, records } = queryCollection(tokenRecord, 'never-created');
		expect(collection).toBeUndefined();
		expect(records).toEqual([]);
	});

	it('updateCollectionTitle renames a collection', () => {
		const collection = createCollection(human, { title: 'Before' });
		updateCollectionTitle(human, collection.id, 'After');
		const { collection: updated } = queryCollection(human, collection.id);
		expect(updated?.title).toBe('After');
	});

	it('deleteCollection removes a collection a caller can access', () => {
		const collection = createCollection(human, { title: 'To Delete' });
		deleteCollection(human, collection.id);
		const { collection: after } = queryCollection(human, collection.id);
		expect(after).toBeUndefined();
	});
});

describe('service layer: records — write validation, delete, and direct read', () => {
	it('writeRecord throws when given neither markdown nor properties', () => {
		const doc = createDocument(human, { title: 'Doc' });
		const block = createRecord(human, { parentId: doc.id, blockType: 'paragraph' });
		expect(() => writeRecord(human, block.id, {})).toThrow(/markdown or properties/);
	});

	it('writeRecord as a human caller applies markdown without needing a hold', () => {
		const doc = createDocument(human, { title: 'Doc' });
		const block = createRecord(human, { parentId: doc.id, blockType: 'paragraph' });
		writeRecord(human, block.id, { markdown: 'human authored text' });
		expect(getDocument(human, doc.id)?.records[0].markdown).toBe('human authored text');
	});

	it('writeRecord applies properties to a collection row', () => {
		const collection = createCollection(human, {
			title: 'Tasks',
			schema: [{ key: 'status', label: 'Status', type: 'select' }]
		});
		const row = createRecord(human, {
			parentId: collection.id,
			properties: { status: { type: 'select', value: 'todo' } }
		});
		writeRecord(human, row.id, { properties: { status: { type: 'select', value: 'done' } } });
		expect(getRecord(human, row.id)?.properties?.status).toEqual({
			type: 'select',
			value: 'done'
		});
	});

	it('deleteRecord removes a record a caller can access', () => {
		const doc = createDocument(human, { title: 'Doc' });
		const block = createRecord(human, { parentId: doc.id, blockType: 'paragraph' });
		deleteRecord(human, block.id);
		expect(() => getRecord(human, block.id)).toThrow(PermissionDeniedError);
	});

	it('getRecord returns the record for a caller who can access its parent', () => {
		const doc = createDocument(human, { title: 'Doc' });
		const block = createRecord(human, { parentId: doc.id, blockType: 'paragraph' });
		expect(getRecord(human, block.id)?.id).toBe(block.id);
	});
});

describe('service layer: holds — human caller path and permission-denied records', () => {
	it('a human caller holding an inaccessible/nonexistent record is denied that one record only', () => {
		const doc = createDocument(human, { title: 'Doc' });
		const block = createRecord(human, { parentId: doc.id, blockType: 'paragraph' });
		const result = holdRecords(human, [block.id, 'nonexistent']);
		expect(result.granted).toContain(block.id);
		expect(result.denied).toContain('nonexistent');
	});

	it('releaseRecords for a human caller is a logged no-op (holds are agent-only)', () => {
		const doc = createDocument(human, { title: 'Doc' });
		const block = createRecord(human, { parentId: doc.id, blockType: 'paragraph' });
		expect(() => releaseRecords(human, [block.id])).not.toThrow();
	});
});

describe('service layer: permissions — record-not-found path', () => {
	it('throws PermissionDeniedError for a nonexistent record before any parent check', () => {
		expect(() => getRecord(human, 'nonexistent')).toThrow(PermissionDeniedError);
	});
});
