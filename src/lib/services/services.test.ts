import { describe, expect, it } from 'vitest';
import {
	createCollection,
	createDocument,
	createRecord,
	getDocument,
	holdRecords,
	moveDocument,
	queryCollection,
	searchWorkspace,
	writeRecord,
	PermissionDeniedError,
	HoldRequiredError
} from './index';
import { createToken, verifyToken } from '$lib/mcp/tokens';
import { queryAuditLog } from '$lib/server/audit';
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
});
