import { describe, expect, it } from 'vitest';
import {
	createCollection,
	createDocument,
	createRecord,
	deleteCollection,
	deleteDocument,
	deleteRecord,
	getDocument as servicesGetDocument,
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
	HoldRequiredError,
	InvalidLinkTargetError
} from './index';
import { projectDocument } from '$lib/mcp/document-projection';

/**
 * `services/documents.ts#getDocument` returns protocol-neutral data with no
 * markdown rendering (#191) — that now happens in
 * `$lib/mcp/document-projection.ts`, the same place the real `get_document`
 * MCP tool renders it. This test file's assertions were all written against
 * the old markdown-shaped result, so this composes the two back together
 * once here rather than rewriting every call site below.
 */
function getDocument(...args: Parameters<typeof servicesGetDocument>) {
	const result = servicesGetDocument(...args);
	return result ? projectDocument(args[1], result) : null;
}
import { createToken, verifyToken } from '$lib/mcp/tokens';
import { queryAuditLog } from '$lib/server/audit';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import {
	createDocument as rawCrdtCreateDocument,
	getDocument as crdtGetDocument
} from '$lib/data/document-ops';
import {
	createCollection as rawCrdtCreateCollection,
	getCollection as crdtGetCollection
} from '$lib/data/collection-ops';
import {
	createRecord as rawCrdtCreateRecord,
	getRecord as crdtGetRecord,
	getRecordYText as crdtGetRecordYText,
	patchRecordViewConfig as crdtPatchRecordViewConfig
} from '$lib/data/record-ops';
import { TEST_ORIGIN, transactWithOrigin } from '$lib/mutation-origin';
import {
	listCatalogCollections,
	listCatalogDocuments,
	RecordIdConflictError,
	reserveCollectionLocator,
	reserveRecordLocator,
	recordCatalogCollectionCreated,
	resolveShardForRecord
} from '$lib/server/catalog';
import { blockTypes, type ActorId, type EmbeddedViewConfig } from '$lib/data/types';

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

function writeTestYText(doc: Parameters<typeof transactWithOrigin>[0], write: () => void): void {
	transactWithOrigin(doc, TEST_ORIGIN, write);
}

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

		// The human caller is unscoped, so createRecord's referencedRecordId
		// validation (accessible-Document check) trivially passes here — the
		// scoping under test below is entirely about the later *read* by a
		// token restricted to docPublic only.
		const link = createRecord(human, {
			parentId: docPublic.id,
			blockType: 'page_link',
			referencedRecordId: docSecret.id
		});

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
		const { workspaceId, defaultSpaceId } = resolveWorkspaceContext({ shardId: docPublic.id });
		const link = crdtCreateRecord(
			resolveWorkspaceContext({ shardId: docPublic.id }).doc,
			{ parentId: docPublic.id, blockType: 'page_link' },
			human
		);
		// A record created directly against the CRDT layer (bypassing the
		// service layer's createRecord, and therefore its locator reservation)
		// needs its own locator entry too, mirroring what real content always
		// has — writeRecord below resolves it by bare recordId alone.
		reserveRecordLocator(workspaceId, defaultSpaceId, link.id, docPublic.id);
		writeRecord(human, link.id, { markdown: 'unresolved link text' });

		const result = getDocument(human, docPublic.id);
		const linkRecord = result?.records.find((r) => r.id === link.id);
		expect(linkRecord?.markdown).toBe('unresolved link text');
	});

	it('marks a page_link explicitly broken, not silently unset, once its target Document is deleted', () => {
		const docPublic = createDocument(human, { title: 'Public Handbook' });
		const docTarget = createDocument(human, { title: 'Will Be Deleted' });
		const link = crdtCreateRecord(
			resolveWorkspaceContext({ shardId: docPublic.id }).doc,
			{ parentId: docPublic.id, blockType: 'page_link', referencedRecordId: docTarget.id },
			human
		);

		deleteDocument(human, docTarget.id);

		const result = getDocument(human, docPublic.id);
		const linkRecord = result?.records.find((r) => r.id === link.id);
		expect(linkRecord?.linkBroken).toBe(true);
		expect(linkRecord?.markdown).toBe('[[Deleted page]]');
		// The ID itself is preserved (not cleared) — the link is broken, not
		// silently forgotten, so a caller can still see what it used to point at.
		expect(linkRecord?.referencedRecordId).toBe(docTarget.id);
	});

	it('does not mark linkBroken for a page_link with no target set yet', () => {
		const docPublic = createDocument(human, { title: 'Public Handbook' });
		const link = crdtCreateRecord(
			resolveWorkspaceContext({ shardId: docPublic.id }).doc,
			{ parentId: docPublic.id, blockType: 'page_link' },
			human
		);

		const result = getDocument(human, docPublic.id);
		const linkRecord = result?.records.find((r) => r.id === link.id);
		expect(linkRecord?.linkBroken).toBeUndefined();
	});

	it('omits a collection_view target outside the caller token scope instead of leaking its schema', () => {
		const docPublic = createDocument(human, { title: 'Team Page' });
		const collectionSecret = createCollection(human, {
			title: 'Secret Tasks',
			schema: [{ key: 'status', label: 'Status', type: 'select' }]
		});
		const embed = crdtCreateRecord(
			resolveWorkspaceContext({ shardId: docPublic.id }).doc,
			{
				parentId: docPublic.id,
				blockType: 'collection_view',
				referencedRecordId: collectionSecret.id,
				viewConfig: { viewType: 'board', groupBy: 'status' }
			},
			human
		);

		const { record: tokenRecord } = createToken({
			clientLabel: 'Scoped Bot',
			allowedDocumentIds: [docPublic.id],
			allowedCollectionIds: []
		});

		const scoped = getDocument(tokenRecord, docPublic.id);
		const scopedEmbed = scoped?.records.find((r) => r.id === embed.id);
		expect(scopedEmbed?.referencedRecordId).toBeUndefined();
		expect(scopedEmbed?.viewConfig).toBeUndefined();
		expect(scopedEmbed?.markdown).toBe('[collection view: unconfigured]');

		const full = getDocument(human, docPublic.id);
		const fullEmbed = full?.records.find((r) => r.id === embed.id);
		expect(fullEmbed?.referencedRecordId).toBe(collectionSecret.id);
		expect(fullEmbed?.viewConfig).toEqual({ viewType: 'board', groupBy: 'status' });
		expect(fullEmbed?.markdown).toBe('[collection view: Secret Tasks]');
	});

	it('marks a collection_view explicitly broken once its target Collection is deleted, preserving the id', () => {
		const docPublic = createDocument(human, { title: 'Team Page' });
		const collectionTarget = createCollection(human, { title: 'Will Be Deleted', schema: [] });
		const embed = crdtCreateRecord(
			resolveWorkspaceContext({ shardId: docPublic.id }).doc,
			{
				parentId: docPublic.id,
				blockType: 'collection_view',
				referencedRecordId: collectionTarget.id,
				viewConfig: { viewType: 'table' }
			},
			human
		);

		deleteCollection(human, collectionTarget.id);

		const result = getDocument(human, docPublic.id);
		const embedRecord = result?.records.find((r) => r.id === embed.id);
		expect(embedRecord?.linkBroken).toBe(true);
		expect(embedRecord?.markdown).toBe('[collection view: Deleted collection]');
		expect(embedRecord?.referencedRecordId).toBe(collectionTarget.id);
		expect(embedRecord?.viewConfig).toBeUndefined();
	});

	it('marks a collection_view broken when its referencedRecordId names a Document, not a Collection', () => {
		const docPublic = createDocument(human, { title: 'Team Page' });
		const docTarget = createDocument(human, { title: 'Not A Collection' });
		const embed = crdtCreateRecord(
			resolveWorkspaceContext({ shardId: docPublic.id }).doc,
			{
				parentId: docPublic.id,
				blockType: 'collection_view',
				referencedRecordId: docTarget.id,
				viewConfig: { viewType: 'table' }
			},
			human
		);

		const result = getDocument(human, docPublic.id);
		const embedRecord = result?.records.find((r) => r.id === embed.id);
		expect(embedRecord?.linkBroken).toBe(true);
		expect(embedRecord?.markdown).toBe('[collection view: Deleted collection]');
		expect(embedRecord?.referencedRecordId).toBe(docTarget.id);
		expect(embedRecord?.viewConfig).toBeUndefined();
	});

	// Regression coverage for a CodeRabbit finding on #172: the read side
	// (getDocument) didn't reject a page_link whose target resolves to a
	// Collection, even though validatePageLinkTarget already rejects that at
	// write time on the MCP path (services/records.ts) — reachable via a
	// direct UI edit (setRecordReferencedId), which isn't routed through that
	// validation. Mirrors the collection_view-wrong-kind test above.
	it('marks a page_link broken when its referencedRecordId names a Collection, not a Document', () => {
		const docPublic = createDocument(human, { title: 'Team Page' });
		const collectionTarget = createCollection(human, { title: 'Not A Document', schema: [] });
		const link = crdtCreateRecord(
			resolveWorkspaceContext({ shardId: docPublic.id }).doc,
			{ parentId: docPublic.id, blockType: 'page_link', referencedRecordId: collectionTarget.id },
			human
		);

		const result = getDocument(human, docPublic.id);
		const linkRecord = result?.records.find((r) => r.id === link.id);
		expect(linkRecord?.linkBroken).toBe(true);
		expect(linkRecord?.markdown).toBe('[[Deleted page]]');
		expect(linkRecord?.referencedRecordId).toBe(collectionTarget.id);
	});

	describe('callout style (issue #42)', () => {
		it('emits a GitHub-alert-style prefix for a preset callout, and exposes calloutStyle read-only', () => {
			const docPublic = createDocument(human, { title: 'Handbook' });
			const doc = resolveWorkspaceContext({ shardId: docPublic.id }).doc;
			const callout = crdtCreateRecord(
				doc,
				{
					parentId: docPublic.id,
					blockType: 'callout',
					calloutStyle: { kind: 'preset', preset: 'danger' }
				},
				human
			);
			writeTestYText(doc, () =>
				crdtGetRecordYText(doc, callout.id)!.insert(0, 'Handle with care.')
			);

			const result = getDocument(human, docPublic.id);
			const record = result?.records.find((r) => r.id === callout.id);
			expect(record?.calloutStyle).toEqual({ kind: 'preset', preset: 'danger' });
			expect(record?.markdown).toBe('> [!DANGER]\n> Handle with care\\.');
		});

		it('quotes every line of a multi-line preset callout, not just the first', () => {
			const docPublic = createDocument(human, { title: 'Handbook' });
			const doc = resolveWorkspaceContext({ shardId: docPublic.id }).doc;
			const callout = crdtCreateRecord(
				doc,
				{
					parentId: docPublic.id,
					blockType: 'callout',
					calloutStyle: { kind: 'preset', preset: 'note' }
				},
				human
			);
			writeTestYText(doc, () =>
				crdtGetRecordYText(doc, callout.id)!.insert(0, 'First line\nSecond line')
			);

			const result = getDocument(human, docPublic.id);
			const record = result?.records.find((r) => r.id === callout.id);
			expect(record?.markdown).toBe('> [!NOTE]\n> First line\n> Second line');
		});

		it('emits just the alert marker for an empty preset callout', () => {
			const docPublic = createDocument(human, { title: 'Handbook' });
			crdtCreateRecord(
				resolveWorkspaceContext({ shardId: docPublic.id }).doc,
				{
					parentId: docPublic.id,
					blockType: 'callout',
					calloutStyle: { kind: 'preset', preset: 'tip' }
				},
				human
			);

			const result = getDocument(human, docPublic.id);
			const record = result?.records.find((r) => r.blockType === 'callout');
			expect(record?.markdown).toBe('> [!TIP]');
		});

		it('renders a custom-styled callout as plain content — no markdown alert equivalent for an arbitrary color', () => {
			const docPublic = createDocument(human, { title: 'Handbook' });
			const doc = resolveWorkspaceContext({ shardId: docPublic.id }).doc;
			const callout = crdtCreateRecord(
				doc,
				{
					parentId: docPublic.id,
					blockType: 'callout',
					calloutStyle: { kind: 'custom', icon: 'star', color: '#336699' }
				},
				human
			);
			writeTestYText(doc, () =>
				crdtGetRecordYText(doc, callout.id)!.insert(0, 'Plain text, styled cell only.')
			);

			const result = getDocument(human, docPublic.id);
			const record = result?.records.find((r) => r.id === callout.id);
			expect(record?.calloutStyle).toEqual({ kind: 'custom', icon: 'star', color: '#336699' });
			expect(record?.markdown).toBe('Plain text, styled cell only\\.');
		});

		it('renders an unstyled callout as plain content, same as before issue #42', () => {
			const docPublic = createDocument(human, { title: 'Handbook' });
			const doc = resolveWorkspaceContext({ shardId: docPublic.id }).doc;
			const callout = crdtCreateRecord(
				doc,
				{ parentId: docPublic.id, blockType: 'callout' },
				human
			);
			writeTestYText(doc, () => crdtGetRecordYText(doc, callout.id)!.insert(0, 'Careful!'));

			const result = getDocument(human, docPublic.id);
			const record = result?.records.find((r) => r.id === callout.id);
			expect(record?.calloutStyle).toBeUndefined();
			expect(record?.markdown).toBe('Careful\\!');
		});
	});

	describe('child_pages block (issue #43)', () => {
		it("defaults to listing the containing Document's own immediate children when no target/depth is set", () => {
			const root = createDocument(human, { title: 'Root' });
			const childA = createDocument(human, { title: 'Child A', parentDocumentId: root.id });
			createDocument(human, {
				title: 'Child B',
				parentDocumentId: root.id,
				afterDocumentId: childA.id
			});
			createDocument(human, { title: 'Grandchild', parentDocumentId: childA.id });
			createRecord(human, { parentId: root.id, blockType: 'child_pages' });

			const result = getDocument(human, root.id);
			const record = result?.records.find((r) => r.blockType === 'child_pages');
			expect(record?.referencedRecordId).toBeUndefined();
			expect(record?.childPagesDepth).toBeUndefined();
			expect(record?.markdown).toBe('- [[Child A]]\n- [[Child B]]');
		});

		it("lists an explicit target Document's children, nested per its configured depth", () => {
			const other = createDocument(human, { title: 'Other Root' });
			const child = createDocument(human, { title: 'Other Child', parentDocumentId: other.id });
			createDocument(human, { title: 'Other Grandchild', parentDocumentId: child.id });
			const host = createDocument(human, { title: 'Host' });
			const block = createRecord(human, {
				parentId: host.id,
				blockType: 'child_pages',
				referencedRecordId: other.id,
				childPagesDepth: 2
			});

			const result = getDocument(human, host.id);
			const record = result?.records.find((r) => r.id === block.id);
			expect(record?.referencedRecordId).toBe(other.id);
			expect(record?.childPagesDepth).toBe(2);
			expect(record?.markdown).toBe('- [[Other Child]]\n  - [[Other Grandchild]]');
		});

		it('emits a placeholder for a target with no sub-pages', () => {
			const host = createDocument(human, { title: 'Host' });
			createRecord(human, { parentId: host.id, blockType: 'child_pages' });

			const result = getDocument(human, host.id);
			const record = result?.records.find((r) => r.blockType === 'child_pages');
			expect(record?.markdown).toBe('_No sub-pages yet._');
		});

		it('rejects create_record with childPagesDepth on any other block type', () => {
			const host = createDocument(human, { title: 'Host' });
			expect(() =>
				createRecord(human, { parentId: host.id, blockType: 'paragraph', childPagesDepth: 2 })
			).toThrow(/childPagesDepth/);
		});

		it('rejects create_record with a childPagesDepth that is neither a positive integer nor "unlimited"', () => {
			const host = createDocument(human, { title: 'Host' });
			expect(() =>
				createRecord(human, { parentId: host.id, blockType: 'child_pages', childPagesDepth: 0 })
			).toThrow(/childPagesDepth/);
			expect(() =>
				createRecord(human, { parentId: host.id, blockType: 'child_pages', childPagesDepth: 1.5 })
			).toThrow(/childPagesDepth/);
		});

		it('rejects create_record with a referencedRecordId pointing at a Collection instead of a Document', () => {
			const col = createCollection(human, { title: 'Rows' });
			const host = createDocument(human, { title: 'Host' });
			expect(() =>
				createRecord(human, {
					parentId: host.id,
					blockType: 'child_pages',
					referencedRecordId: col.id
				})
			).toThrow(/Document/);
		});

		it('rejects a targetless, default-depth child_pages block under a Collection parent', () => {
			const col = createCollection(human, { title: 'Rows' });
			expect(() => createRecord(human, { parentId: col.id, blockType: 'child_pages' })).toThrow(
				/Document/
			);
		});

		it('renders "[child pages: unavailable]" for a deleted target, without distinguishing it from an out-of-scope one', () => {
			const target = createDocument(human, { title: 'Target' });
			const host = createDocument(human, { title: 'Host' });
			const block = createRecord(human, {
				parentId: host.id,
				blockType: 'child_pages',
				referencedRecordId: target.id
			});
			deleteDocument(human, target.id);

			const result = getDocument(human, host.id);
			const record = result?.records.find((r) => r.id === block.id);
			expect(record?.markdown).toBe('[child pages: unavailable]');
			expect(record?.linkBroken).toBe(true);
			// Preserved for recovery even once broken — same rule page_link's
			// referencedRecordId already follows (mcp-tools.md); only an
			// out-of-scope target (not a merely-deleted one) is omitted.
			expect(record?.referencedRecordId).toBe(target.id);
		});

		it('renders "[child pages: unavailable]" and omits referencedRecordId when the target is outside the caller token scope', () => {
			const secret = createDocument(human, { title: 'Secret' });
			const host = createDocument(human, { title: 'Host' });
			const block = createRecord(human, {
				parentId: host.id,
				blockType: 'child_pages',
				referencedRecordId: secret.id
			});

			const { record: tokenRecord } = createToken({
				clientLabel: 'Scoped Child Pages Bot',
				allowedDocumentIds: [host.id],
				allowedCollectionIds: []
			});

			const result = getDocument(tokenRecord, host.id);
			const record = result?.records.find((r) => r.id === block.id);
			expect(record?.markdown).toBe('[child pages: unavailable]');
			expect(record?.referencedRecordId).toBeUndefined();
		});

		it("silently excludes a child the caller's token was never granted access to, rather than erroring", () => {
			const root = createDocument(human, { title: 'Root' });
			const visibleChild = createDocument(human, {
				title: 'Visible Child',
				parentDocumentId: root.id
			});
			createDocument(human, { title: 'Hidden Child', parentDocumentId: root.id });
			createRecord(human, { parentId: root.id, blockType: 'child_pages' });

			const { record: tokenRecord } = createToken({
				clientLabel: 'Scoped Sibling Bot',
				allowedDocumentIds: [root.id, visibleChild.id],
				allowedCollectionIds: []
			});

			const result = getDocument(tokenRecord, root.id);
			const record = result?.records.find((r) => r.blockType === 'child_pages');
			expect(record?.markdown).toBe('- [[Visible Child]]');
		});
	});

	// Regression coverage for a CodeRabbit finding on #172: an uncataloged
	// target (no locator row) has no resolved spaceId, so a token relying
	// solely on a default-Space grant (not a per-id grant) was silently
	// denied access to it — hiding an otherwise-accessible page_link instead
	// of rendering it.
	it('resolves a page_link to an uncataloged Document via a default-Space-only grant', () => {
		const docPublic = createDocument(human, { title: 'Team Page' });
		const { doc, defaultSpaceId } = resolveWorkspaceContext();
		const uncatalogedTarget = crdtCreateDocument(doc, { title: 'Uncataloged Target' });
		const link = crdtCreateRecord(
			resolveWorkspaceContext({ shardId: docPublic.id }).doc,
			{
				parentId: docPublic.id,
				blockType: 'page_link',
				referencedRecordId: uncatalogedTarget.id
			},
			human
		);
		const { record: tokenRecord } = createToken({
			clientLabel: 'Space-Scoped Bot',
			allowedDocumentIds: [docPublic.id],
			allowedCollectionIds: [],
			allowedSpaceIds: [defaultSpaceId]
		});

		const result = getDocument(tokenRecord, docPublic.id);
		const linkRecord = result?.records.find((r) => r.id === link.id);
		expect(linkRecord?.linkBroken).toBeUndefined();
		expect(linkRecord?.referencedRecordId).toBe(uncatalogedTarget.id);
		expect(linkRecord?.markdown).toBe('[[Uncataloged Target]]');
	});
});

describe('service layer: MCP authoring and repair of page_link targets (issue #46)', () => {
	it('creates a page_link block with a valid, accessible target in one call', () => {
		const target = createDocument(human, { title: 'Target Doc' });
		const source = createDocument(human, { title: 'Source Doc' });

		const { record: tokenRecord } = createToken({
			clientLabel: 'Linker Bot',
			allowedDocumentIds: [target.id, source.id],
			allowedCollectionIds: []
		});

		const link = createRecord(tokenRecord, {
			parentId: source.id,
			blockType: 'page_link',
			referencedRecordId: target.id
		});

		const result = getDocument(tokenRecord, source.id);
		const linkRecord = result?.records.find((r) => r.id === link.id);
		expect(linkRecord?.referencedRecordId).toBe(target.id);
		expect(linkRecord?.markdown).toBe('[[Target Doc]]');
	});

	it('rejects referencedRecordId on create_record when blockType is not page_link', () => {
		const target = createDocument(human, { title: 'Target Doc' });
		const source = createDocument(human, { title: 'Source Doc' });

		expect(() =>
			createRecord(human, {
				parentId: source.id,
				blockType: 'paragraph',
				referencedRecordId: target.id
			})
		).toThrow(/page_link/);
	});

	it('rejects referencedRecordId on create_record when the parent is a Collection, not a Document', () => {
		const target = createDocument(human, { title: 'Target Doc' });
		const col = createCollection(human, { title: 'Tasks', schema: [] });

		expect(() =>
			createRecord(human, {
				parentId: col.id,
				blockType: 'page_link',
				referencedRecordId: target.id
			})
		).toThrow(/Document/);
	});

	it('rejects a targetless page_link under a Collection parent without creating a row', () => {
		const col = createCollection(human, { title: 'Tasks', schema: [] });

		expect(() => createRecord(human, { parentId: col.id, blockType: 'page_link' })).toThrow(
			/Document/
		);
		expect(queryCollection(human, col.id).records).toEqual([]);
	});

	it('rejects every explicit Document block type under a Collection parent', () => {
		const col = createCollection(human, { title: 'Tasks', schema: [] });

		for (const blockType of blockTypes) {
			expect(() => createRecord(human, { parentId: col.id, blockType })).toThrow(/Document/);
		}
		expect(queryCollection(human, col.id).records).toEqual([]);
	});

	it('rejects create_record with a referencedRecordId the token was never granted access to, without distinguishing "forbidden" from "nonexistent"', () => {
		const secret = createDocument(human, { title: 'Secret Doc' });
		const source = createDocument(human, { title: 'Source Doc' });

		const { record: tokenRecord } = createToken({
			clientLabel: 'Scoped Bot',
			allowedDocumentIds: [source.id],
			allowedCollectionIds: []
		});

		let forbiddenErr: Error | undefined;
		try {
			createRecord(tokenRecord, {
				parentId: source.id,
				blockType: 'page_link',
				referencedRecordId: secret.id
			});
		} catch (err) {
			forbiddenErr = err as Error;
		}
		expect(forbiddenErr).toBeInstanceOf(InvalidLinkTargetError);
		expect(forbiddenErr!.message).not.toContain('Secret Doc');

		let missingErr: Error | undefined;
		try {
			createRecord(tokenRecord, {
				parentId: source.id,
				blockType: 'page_link',
				referencedRecordId: 'does-not-exist'
			});
		} catch (err) {
			missingErr = err as Error;
		}
		expect(missingErr).toBeInstanceOf(InvalidLinkTargetError);

		// Same generic message shape for "exists but forbidden" and "doesn't
		// exist" — swapping each error's own target ID out for a placeholder
		// makes the two messages identical, proving neither wording nor
		// structure lets a caller distinguish the two cases.
		expect(forbiddenErr!.message.replace(secret.id, 'X')).toBe(
			missingErr!.message.replace('does-not-exist', 'X')
		);

		const result = getDocument(human, source.id);
		expect(result?.records).toHaveLength(0);
	});

	it('retargets an existing page_link via write_record, without needing a hold, and is idempotent', () => {
		const targetA = createDocument(human, { title: 'Target A' });
		const targetB = createDocument(human, { title: 'Target B' });
		const source = createDocument(human, { title: 'Source Doc' });

		const { record: tokenRecord } = createToken({
			clientLabel: 'Retarget Bot',
			allowedDocumentIds: [targetA.id, targetB.id, source.id],
			allowedCollectionIds: []
		});

		const link = createRecord(tokenRecord, {
			parentId: source.id,
			blockType: 'page_link',
			referencedRecordId: targetA.id
		});

		// No hold_records call first — a metadata-only write is exempt.
		writeRecord(tokenRecord, link.id, { referencedRecordId: targetB.id });
		let result = getDocument(tokenRecord, source.id);
		expect(result?.records.find((r) => r.id === link.id)?.referencedRecordId).toBe(targetB.id);

		// Idempotent: writing the same target again is a no-op state transition.
		writeRecord(tokenRecord, link.id, { referencedRecordId: targetB.id });
		result = getDocument(tokenRecord, source.id);
		expect(result?.records.find((r) => r.id === link.id)?.referencedRecordId).toBe(targetB.id);

		const audits = queryAuditLog();
		const retargetEntries = audits.filter(
			(a) => a.action === 'write_record' && a.targetRecordId === link.id
		);
		expect(retargetEntries.length).toBeGreaterThanOrEqual(2);
	});

	it('rejects retargeting a block that is not a page_link', () => {
		const target = createDocument(human, { title: 'Target Doc' });
		const doc = createDocument(human, { title: 'Doc' });
		const block = createRecord(human, { parentId: doc.id, blockType: 'paragraph' });

		expect(() => writeRecord(human, block.id, { referencedRecordId: target.id })).toThrow(
			/page_link/
		);
	});

	it('rejects retargeting a page_link to a Document outside the caller token scope', () => {
		const secret = createDocument(human, { title: 'Secret Doc' });
		const target = createDocument(human, { title: 'Target Doc' });
		const source = createDocument(human, { title: 'Source Doc' });
		const link = createRecord(human, {
			parentId: source.id,
			blockType: 'page_link',
			referencedRecordId: target.id
		});

		const { record: tokenRecord } = createToken({
			clientLabel: 'Scoped Retargeter',
			allowedDocumentIds: [source.id, target.id],
			allowedCollectionIds: []
		});

		expect(() => writeRecord(tokenRecord, link.id, { referencedRecordId: secret.id })).toThrow(
			InvalidLinkTargetError
		);

		// Rejected retarget leaves the original target untouched.
		const result = getDocument(tokenRecord, source.id);
		expect(result?.records.find((r) => r.id === link.id)?.referencedRecordId).toBe(target.id);
	});

	it('rejects a combined write_record call with an invalid referencedRecordId before applying its markdown', () => {
		const secret = createDocument(human, { title: 'Secret Doc' });
		const source = createDocument(human, { title: 'Source Doc' });
		const link = createRecord(human, { parentId: source.id, blockType: 'page_link' });

		const { record: tokenRecord } = createToken({
			clientLabel: 'Combined Write Bot',
			allowedDocumentIds: [source.id],
			allowedCollectionIds: []
		});
		holdRecords(tokenRecord, [link.id]);

		expect(() =>
			writeRecord(tokenRecord, link.id, {
				markdown: 'unresolved link text',
				referencedRecordId: secret.id
			})
		).toThrow(InvalidLinkTargetError);

		// The markdown write never committed, and the hold was never consumed —
		// validation ran before any mutation (docs/specifications/mcp-tools.md).
		const result = getDocument(human, source.id);
		const linkRecord = result?.records.find((r) => r.id === link.id);
		expect(linkRecord?.markdown).toBe('');
		expect(linkRecord?.referencedRecordId).toBeUndefined();
		expect(holdRecords(tokenRecord, [link.id]).granted).toContain(link.id);
	});
});

describe('service layer: MCP authoring and validation of collection_view targets (issue #37)', () => {
	it('creates a collection_view block with a valid, accessible Collection target and viewConfig in one call', () => {
		const target = createCollection(human, { title: 'Tasks', schema: [] });
		const source = createDocument(human, { title: 'Source Doc' });

		const { record: tokenRecord } = createToken({
			clientLabel: 'Embed Bot',
			allowedDocumentIds: [source.id],
			allowedCollectionIds: [target.id]
		});

		const embed = createRecord(tokenRecord, {
			parentId: source.id,
			blockType: 'collection_view',
			referencedRecordId: target.id,
			viewConfig: { viewType: 'table' }
		});

		const result = getDocument(tokenRecord, source.id);
		const embedRecord = result?.records.find((r) => r.id === embed.id);
		expect(embedRecord?.referencedRecordId).toBe(target.id);
		expect(embedRecord?.viewConfig).toEqual({ viewType: 'table' });
		expect(embedRecord?.markdown).toBe('[collection view: Tasks]');
	});

	it('rejects referencedRecordId on create_record for a collection_view whose target is a Document, not a Collection', () => {
		const target = createDocument(human, { title: 'Not A Collection' });
		const source = createDocument(human, { title: 'Source Doc' });

		expect(() =>
			createRecord(human, {
				parentId: source.id,
				blockType: 'collection_view',
				referencedRecordId: target.id
			})
		).toThrow(/Collection/);
	});

	it('rejects create_record with a collection_view referencedRecordId the token was never granted access to, without distinguishing "forbidden" from "nonexistent"', () => {
		const secret = createCollection(human, { title: 'Secret Tasks', schema: [] });
		const source = createDocument(human, { title: 'Source Doc' });

		const { record: tokenRecord } = createToken({
			clientLabel: 'Scoped Embed Bot',
			allowedDocumentIds: [source.id],
			allowedCollectionIds: []
		});

		let forbiddenErr: Error | undefined;
		try {
			createRecord(tokenRecord, {
				parentId: source.id,
				blockType: 'collection_view',
				referencedRecordId: secret.id
			});
		} catch (err) {
			forbiddenErr = err as Error;
		}
		expect(forbiddenErr).toBeInstanceOf(InvalidLinkTargetError);
		expect(forbiddenErr!.message).not.toContain('Secret Tasks');

		let missingErr: Error | undefined;
		try {
			createRecord(tokenRecord, {
				parentId: source.id,
				blockType: 'collection_view',
				referencedRecordId: 'does-not-exist'
			});
		} catch (err) {
			missingErr = err as Error;
		}
		expect(missingErr).toBeInstanceOf(InvalidLinkTargetError);

		expect(forbiddenErr!.message.replace(secret.id, 'X')).toBe(
			missingErr!.message.replace('does-not-exist', 'X')
		);

		const result = getDocument(human, source.id);
		expect(result?.records).toHaveLength(0);
	});

	it('rejects viewConfig on create_record when blockType is not collection_view', () => {
		const source = createDocument(human, { title: 'Source Doc' });

		expect(() =>
			createRecord(human, {
				parentId: source.id,
				blockType: 'paragraph',
				viewConfig: { viewType: 'table' }
			})
		).toThrow(/collection_view/);
	});

	it('rejects viewConfig on create_record with an unrecognized viewType', () => {
		const target = createCollection(human, { title: 'Tasks', schema: [] });
		const source = createDocument(human, { title: 'Source Doc' });

		expect(() =>
			createRecord(human, {
				parentId: source.id,
				blockType: 'collection_view',
				referencedRecordId: target.id,
				viewConfig: { viewType: 'invalid' } as unknown as EmbeddedViewConfig
			})
		).toThrow(/viewType/);
	});

	it('retargets an existing collection_view via write_record, and rejects a Document-kind or out-of-scope target', () => {
		const targetA = createCollection(human, { title: 'Tasks A', schema: [] });
		const targetB = createCollection(human, { title: 'Tasks B', schema: [] });
		const docTarget = createDocument(human, { title: 'Not A Collection' });
		const secret = createCollection(human, { title: 'Secret Tasks', schema: [] });
		const source = createDocument(human, { title: 'Source Doc' });

		const { record: tokenRecord } = createToken({
			clientLabel: 'Retarget Embed Bot',
			allowedDocumentIds: [source.id],
			allowedCollectionIds: [targetA.id, targetB.id]
		});

		const embed = createRecord(tokenRecord, {
			parentId: source.id,
			blockType: 'collection_view',
			referencedRecordId: targetA.id
		});

		writeRecord(tokenRecord, embed.id, { referencedRecordId: targetB.id });
		let result = getDocument(tokenRecord, source.id);
		expect(result?.records.find((r) => r.id === embed.id)?.referencedRecordId).toBe(targetB.id);

		expect(() => writeRecord(tokenRecord, embed.id, { referencedRecordId: docTarget.id })).toThrow(
			InvalidLinkTargetError
		);
		expect(() => writeRecord(tokenRecord, embed.id, { referencedRecordId: secret.id })).toThrow(
			InvalidLinkTargetError
		);

		// Neither rejected retarget mutated the block.
		result = getDocument(tokenRecord, source.id);
		expect(result?.records.find((r) => r.id === embed.id)?.referencedRecordId).toBe(targetB.id);
	});

	it('rejects retargeting a block that is not a collection_view via referencedRecordId', () => {
		const target = createCollection(human, { title: 'Tasks', schema: [] });
		const doc = createDocument(human, { title: 'Doc' });
		const block = createRecord(human, { parentId: doc.id, blockType: 'paragraph' });

		expect(() => writeRecord(human, block.id, { referencedRecordId: target.id })).toThrow(
			/page_link|collection_view/
		);
	});

	it('sets viewConfig on an existing collection_view block via write_record, replacing it wholesale', () => {
		const target = createCollection(human, { title: 'Tasks', schema: [] });
		const doc = createDocument(human, { title: 'Doc' });
		const embed = createRecord(human, {
			parentId: doc.id,
			blockType: 'collection_view',
			referencedRecordId: target.id,
			viewConfig: { viewType: 'table', groupBy: 'status' }
		});

		writeRecord(human, embed.id, { viewConfig: { viewType: 'board' } });

		const result = getDocument(human, doc.id);
		// A full replace clears members absent from the new config (groupBy).
		expect(result?.records.find((r) => r.id === embed.id)?.viewConfig).toEqual({
			viewType: 'board'
		});
	});

	it('rejects viewConfig on write_record for a block that is not collection_view', () => {
		const doc = createDocument(human, { title: 'Doc' });
		const block = createRecord(human, { parentId: doc.id, blockType: 'paragraph' });

		expect(() => writeRecord(human, block.id, { viewConfig: { viewType: 'table' } })).toThrow(
			/collection_view/
		);
	});
});

describe('service layer: write_record viewConfigPatch — per-member merge without clobbering untouched members (issue #195)', () => {
	it('merges only the named members, leaving a concurrently-set member untouched', () => {
		const target = createCollection(human, { title: 'Tasks', schema: [] });
		const doc = createDocument(human, { title: 'Doc' });
		const embed = createRecord(human, {
			parentId: doc.id,
			blockType: 'collection_view',
			referencedRecordId: target.id,
			viewConfig: { viewType: 'board', groupBy: 'status', visibleProperties: ['status'] }
		});

		// Simulates a concurrent actor (another agent call, or a human's Save)
		// setting `sort` in between — the bug this issue fixes is a whole-value
		// viewConfig write silently discarding this.
		const shardDoc = resolveWorkspaceContext({ shardId: doc.id }).doc;
		writeTestYText(shardDoc, () =>
			crdtPatchRecordViewConfig(shardDoc, embed.id, { sort: { mode: 'manual' } }, human)
		);

		writeRecord(human, embed.id, { viewConfigPatch: { groupBy: 'priority' } });

		const result = getDocument(human, doc.id);
		expect(result?.records.find((r) => r.id === embed.id)?.viewConfig).toEqual({
			viewType: 'board',
			groupBy: 'priority',
			visibleProperties: ['status'],
			sort: { mode: 'manual' }
		});
	});

	it('clears a member explicitly set to undefined in the patch, leaving the rest untouched', () => {
		const target = createCollection(human, { title: 'Tasks', schema: [] });
		const doc = createDocument(human, { title: 'Doc' });
		const embed = createRecord(human, {
			parentId: doc.id,
			blockType: 'collection_view',
			referencedRecordId: target.id,
			viewConfig: { viewType: 'board', groupBy: 'status', visibleProperties: ['status'] }
		});

		writeRecord(human, embed.id, { viewConfigPatch: { groupBy: undefined } });

		const result = getDocument(human, doc.id);
		expect(result?.records.find((r) => r.id === embed.id)?.viewConfig).toEqual({
			viewType: 'board',
			visibleProperties: ['status']
		});

		// The persisted audit diff must record the clear as JSON `null`, not
		// silently drop the key — the audit_log.diff column round-trips
		// through JSON.stringify (Drizzle's `mode: 'json'`), which would
		// otherwise erase any property left as an actual `undefined` value.
		const entry = queryAuditLog().find(
			(a) => a.action === 'write_record' && a.targetRecordId === embed.id
		);
		expect(entry?.diff).toEqual({ viewConfigPatch: { groupBy: null } });
	});

	it('rejects viewConfigPatch on a block that is not collection_view', () => {
		const doc = createDocument(human, { title: 'Doc' });
		const block = createRecord(human, { parentId: doc.id, blockType: 'paragraph' });

		expect(() => writeRecord(human, block.id, { viewConfigPatch: { groupBy: 'status' } })).toThrow(
			/collection_view/
		);
	});

	it('rejects viewConfigPatch on a collection_view block that has no viewConfig yet', () => {
		const target = createCollection(human, { title: 'Tasks', schema: [] });
		const doc = createDocument(human, { title: 'Doc' });
		const embed = createRecord(human, {
			parentId: doc.id,
			blockType: 'collection_view',
			referencedRecordId: target.id
		});

		expect(() => writeRecord(human, embed.id, { viewConfigPatch: { groupBy: 'status' } })).toThrow(
			/already be configured/
		);
	});

	it('rejects a write_record call that supplies both viewConfig and viewConfigPatch', () => {
		const target = createCollection(human, { title: 'Tasks', schema: [] });
		const doc = createDocument(human, { title: 'Doc' });
		const embed = createRecord(human, {
			parentId: doc.id,
			blockType: 'collection_view',
			referencedRecordId: target.id,
			viewConfig: { viewType: 'table' }
		});

		expect(() =>
			writeRecord(human, embed.id, {
				viewConfig: { viewType: 'board' },
				viewConfigPatch: { groupBy: 'status' }
			})
		).toThrow(/either viewConfig or viewConfigPatch/);
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

	it('listDocuments skips an uncataloged document a token has no grant for', () => {
		const uncataloged = crdtCreateDocument(resolveWorkspaceContext().doc, {
			title: 'Uncataloged Doc'
		});
		const { record: tokenRecord } = createToken({
			clientLabel: 'No Access Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});

		const docs = listDocuments(tokenRecord);
		expect(docs.some((d) => d.id === uncataloged.id)).toBe(false);
	});

	it('moveDocument reorders among top-level siblings without a parentDocumentId', () => {
		const docA = createDocument(human, { title: 'Top A' });
		const docB = createDocument(human, { title: 'Top B' });

		expect(() => moveDocument(human, docB.id, { afterDocumentId: docA.id })).not.toThrow();
	});

	it('createDocument does not double-push an id a token was already pre-authorized for', () => {
		const preassignedId = 'preassigned-document-id';
		const { record: tokenRecord } = createToken({
			clientLabel: 'Preauthorized Bot',
			allowedDocumentIds: [preassignedId],
			allowedCollectionIds: []
		});

		createDocument(tokenRecord, { id: preassignedId, title: 'Preassigned' });

		expect(tokenRecord.allowedDocumentIds.filter((id) => id === preassignedId)).toHaveLength(1);
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

	it('createCollection assigns a real, distinct shard — its own id — not the default doc (#120)', () => {
		const collection = createCollection(human, { title: 'Sharded' });

		const { workspaceId } = resolveWorkspaceContext();
		const shardDoc = resolveWorkspaceContext({ workspaceId, shardId: collection.id }).doc;
		const defaultDoc = resolveWorkspaceContext({ workspaceId }).doc;

		expect(crdtGetCollection(shardDoc, collection.id)?.title).toBe('Sharded');
		expect(crdtGetCollection(defaultDoc, collection.id)).toBeUndefined();

		// listCollections finds it via the catalog fan-out, reading full
		// CollectionMeta (schema) from its real shard.
		const listed = listCollections(human).find((c) => c.id === collection.id);
		expect(listed?.title).toBe('Sharded');
	});

	it('createCollection does not double-push an id a token was already pre-authorized for', () => {
		const preassignedId = 'preassigned-collection-id';
		const { record: tokenRecord } = createToken({
			clientLabel: 'Preauthorized Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: [preassignedId]
		});

		createCollection(tokenRecord, { id: preassignedId, title: 'Preassigned', schema: [] });

		expect(tokenRecord.allowedCollectionIds.filter((id) => id === preassignedId)).toHaveLength(1);
	});

	it('listCollections skips an uncataloged collection a token has no grant for', () => {
		const uncataloged = crdtCreateCollection(resolveWorkspaceContext().doc, {
			title: 'Uncataloged Table',
			schema: []
		});
		const { record: tokenRecord } = createToken({
			clientLabel: 'No Access Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});

		const results = listCollections(tokenRecord);
		expect(results.some((c) => c.id === uncataloged.id)).toBe(false);
	});
});

describe('service layer: records — write validation, delete, and direct read', () => {
	it('writeRecord throws when given neither markdown nor properties', () => {
		const doc = createDocument(human, { title: 'Doc' });
		const block = createRecord(human, { parentId: doc.id, blockType: 'paragraph' });
		expect(() => writeRecord(human, block.id, {})).toThrow(
			/markdown, properties, referencedRecordId, viewConfig, or viewConfigPatch/
		);
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

describe('service layer: denied access attempts are themselves audited (docs/specifications/audit-coverage.md §3)', () => {
	it('logs a create_record_denied event, attributed to the token, when a token lacks access to the parent', () => {
		const doc = createDocument(human, { title: 'Denial Audit Doc' });
		const { record: tokenRecord } = createToken({
			clientLabel: 'Denied Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});

		expect(() => createRecord(tokenRecord, { parentId: doc.id, blockType: 'paragraph' })).toThrow(
			PermissionDeniedError
		);

		const entry = queryAuditLog().find(
			(a) => a.action === 'create_record_denied' && a.targetRecordId === doc.id
		);
		expect(entry).toBeDefined();
		expect(entry?.actor.kind).toBe('human-via-client');
	});

	it('logs a get_document_denied event when a token requests a document outside its grant', () => {
		const doc = createDocument(human, { title: 'Denial Audit Get Doc' });
		const { record: tokenRecord } = createToken({
			clientLabel: 'Denied Bot 2',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});

		expect(() => getDocument(tokenRecord, doc.id)).toThrow(PermissionDeniedError);
		expect(
			queryAuditLog().some((a) => a.action === 'get_document_denied' && a.targetRecordId === doc.id)
		).toBe(true);
	});

	it('does not log a denial for a human caller (requireAccessibleParent never denies CURRENT_USER)', () => {
		const doc = createDocument(human, { title: 'Human Never Denied Doc' });
		getDocument(human, doc.id); // succeeds — not a denial
		expect(
			queryAuditLog().some((a) => a.action === 'get_document_denied' && a.targetRecordId === doc.id)
		).toBe(false);
	});

	it('a token requesting a nonexistent record logs a denial without leaking any content about it', () => {
		const { record: tokenRecord } = createToken({
			clientLabel: 'Denied Bot 3',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});
		expect(() => writeRecord(tokenRecord, 'nonexistent-record-id', { markdown: 'x' })).toThrow(
			PermissionDeniedError
		);
		const entry = queryAuditLog().find(
			(a) => a.action === 'write_record_denied' && a.targetRecordId === 'nonexistent-record-id'
		);
		expect(entry).toBeDefined();
		expect(entry?.diff).toBeUndefined();
	});
});

describe('service layer: catalog stays in sync with Y.Doc document/collection mutations (#113 Phase A)', () => {
	function catalogWorkspaceId(): string {
		return resolveWorkspaceContext().workspaceId;
	}

	it('mirrors document create, rename, move, and delete into the catalog', () => {
		const parent = createDocument(human, { title: 'Catalog Parent' });
		const child = createDocument(human, { title: 'Catalog Child' });

		let catalog = listCatalogDocuments(catalogWorkspaceId());
		expect(catalog.find((d) => d.id === parent.id)?.title).toBe('Catalog Parent');
		expect(catalog.find((d) => d.id === child.id)?.parentDocumentId).toBeUndefined();

		updateDocumentTitle(human, child.id, 'Renamed Child');
		catalog = listCatalogDocuments(catalogWorkspaceId());
		expect(catalog.find((d) => d.id === child.id)?.title).toBe('Renamed Child');

		moveDocument(human, child.id, { parentDocumentId: parent.id });
		catalog = listCatalogDocuments(catalogWorkspaceId());
		expect(catalog.find((d) => d.id === child.id)?.parentDocumentId).toBe(parent.id);

		deleteDocument(human, parent.id);
		catalog = listCatalogDocuments(catalogWorkspaceId());
		expect(catalog.find((d) => d.id === parent.id)).toBeUndefined();
		expect(catalog.find((d) => d.id === child.id)).toBeUndefined(); // recursive descendant delete
	});

	it('mirrors collection create, rename, and delete into the catalog', () => {
		const col = createCollection(human, { title: 'Catalog Table', schema: [] });

		let catalog = listCatalogCollections(catalogWorkspaceId());
		expect(catalog.find((c) => c.id === col.id)?.title).toBe('Catalog Table');

		updateCollectionTitle(human, col.id, 'Renamed Table');
		catalog = listCatalogCollections(catalogWorkspaceId());
		expect(catalog.find((c) => c.id === col.id)?.title).toBe('Renamed Table');

		deleteCollection(human, col.id);
		catalog = listCatalogCollections(catalogWorkspaceId());
		expect(catalog.find((c) => c.id === col.id)).toBeUndefined();
	});

	it('rejects a caller-supplied document id that collides with an existing record', () => {
		const existing = createDocument(human, { title: 'Existing' });
		expect(() => createDocument(human, { id: existing.id, title: 'Colliding' })).toThrow(
			RecordIdConflictError
		);
	});

	it('rejects a caller-supplied collection id that collides with an existing document', () => {
		const existingDoc = createDocument(human, { title: 'Existing Doc' });
		expect(() =>
			createCollection(human, { id: existingDoc.id, title: 'Colliding Collection', schema: [] })
		).toThrow(RecordIdConflictError);
	});

	it('rejects a caller-supplied id colliding with a document written directly to the Y.Doc, bypassing the service layer (never overwrites it)', () => {
		const { doc } = resolveWorkspaceContext();
		// Simulates a real Yjs client writing straight to the Y.Doc — the
		// locator/catalog never learn about this id, since it never went
		// through reserveDocumentLocator/recordCatalogDocumentCreated.
		const direct = crdtCreateDocument(doc, { title: 'Written Directly To The Y.Doc' });

		expect(() => createDocument(human, { id: direct.id, title: 'Overwrite Attempt' })).toThrow(
			RecordIdConflictError
		);
		// The original content must survive untouched.
		expect(crdtGetDocument(doc, direct.id)?.title).toBe('Written Directly To The Y.Doc');
	});

	it('rejects a caller-supplied id colliding with a collection written directly to the Y.Doc, bypassing the service layer (never overwrites it)', () => {
		const { doc } = resolveWorkspaceContext();
		const direct = crdtCreateCollection(doc, {
			title: 'Written Directly To The Y.Doc',
			schema: []
		});

		expect(() =>
			createCollection(human, { id: direct.id, title: 'Overwrite Attempt', schema: [] })
		).toThrow(RecordIdConflictError);
		expect(crdtGetCollection(doc, direct.id)?.title).toBe('Written Directly To The Y.Doc');
	});

	it('rejects createDocument when the id already names a Collection (cross-type collision, direct Y.Doc write)', () => {
		const { doc } = resolveWorkspaceContext();
		const directCollection = crdtCreateCollection(doc, {
			title: 'A Collection, Written Directly',
			schema: []
		});

		expect(() =>
			createDocument(human, { id: directCollection.id, title: 'Cross-Type Attempt' })
		).toThrow(RecordIdConflictError);
		// The Collection must remain intact and still reachable — not silently
		// shadowed by a same-id Document entry (documentsMap/collectionsMap are
		// separate Y.Maps, so a same-id Document wouldn't overwrite it, but
		// parentKindOf checks the documents map first, making the Collection
		// permanently unreachable via any parentId lookup once both exist).
		expect(crdtGetCollection(doc, directCollection.id)?.title).toBe(
			'A Collection, Written Directly'
		);
		expect(crdtGetDocument(doc, directCollection.id)).toBeUndefined();
	});

	it('rejects createCollection when the id already names a Document (cross-type collision, direct Y.Doc write)', () => {
		const { doc } = resolveWorkspaceContext();
		const directDocument = crdtCreateDocument(doc, { title: 'A Document, Written Directly' });

		expect(() =>
			createCollection(human, { id: directDocument.id, title: 'Cross-Type Attempt', schema: [] })
		).toThrow(RecordIdConflictError);
		expect(crdtGetDocument(doc, directDocument.id)?.title).toBe('A Document, Written Directly');
		expect(crdtGetCollection(doc, directDocument.id)).toBeUndefined();
	});
});

describe('service layer: resolves a genuinely separate Collection shard (#120)', () => {
	const OTHER_SHARD = 'other-shard';
	let nextId = 0;

	// createCollection always assigns shardId 'default' (the real
	// shard-assignment cutover is a separate, later step — see #120) — this
	// bypasses it to construct a Collection whose catalog row names a
	// genuinely different shard, proving every service function resolves it
	// correctly rather than assuming the default doc.
	function createSyntheticShardedCollection(): { collectionId: string; workspaceId: string } {
		const { workspaceId, defaultSpaceId } = resolveWorkspaceContext();
		const collectionId = `synthetic-shard-collection-${nextId++}`;
		reserveCollectionLocator(workspaceId, defaultSpaceId, collectionId, OTHER_SHARD);
		recordCatalogCollectionCreated({
			workspaceId,
			spaceId: defaultSpaceId,
			id: collectionId,
			title: 'Synthetic Sharded Table',
			shardId: OTHER_SHARD
		});
		const { doc: otherDoc } = resolveWorkspaceContext({ workspaceId, shardId: OTHER_SHARD });
		crdtCreateCollection(otherDoc, {
			id: collectionId,
			title: 'Synthetic Sharded Table',
			schema: []
		});
		return { collectionId, workspaceId };
	}

	it('queryCollection reads rows from the resolved shard, not the default doc', () => {
		const { collectionId, workspaceId } = createSyntheticShardedCollection();
		const { doc: otherDoc } = resolveWorkspaceContext({ workspaceId, shardId: OTHER_SHARD });
		crdtCreateRecord(
			otherDoc,
			{
				parentId: collectionId,
				properties: { name: { type: 'text', value: 'Row In Other Shard' } }
			},
			human
		);

		const result = queryCollection(human, collectionId);
		expect(result.collection?.title).toBe('Synthetic Sharded Table');
		expect(result.records).toHaveLength(1);
	});

	it('createRecord targeting a sharded Collection writes into that shard and reserves a row locator', () => {
		const { collectionId, workspaceId } = createSyntheticShardedCollection();

		const record = createRecord(human, {
			parentId: collectionId,
			properties: { name: { type: 'text', value: 'New Row' } }
		});

		expect(resolveShardForRecord(workspaceId, record.id)).toEqual({ shardId: OTHER_SHARD });
		const { doc: otherDoc } = resolveWorkspaceContext({ workspaceId, shardId: OTHER_SHARD });
		expect(crdtGetRecord(otherDoc, record.id)?.properties?.name).toEqual({
			type: 'text',
			value: 'New Row'
		});
	});

	it('writeRecord updates content in the resolved shard', () => {
		const { collectionId, workspaceId } = createSyntheticShardedCollection();
		const record = createRecord(human, { parentId: collectionId, properties: {} });

		writeRecord(human, record.id, { properties: { status: { type: 'text', value: 'Done' } } });

		const { doc: otherDoc } = resolveWorkspaceContext({ workspaceId, shardId: OTHER_SHARD });
		expect(crdtGetRecord(otherDoc, record.id)?.properties?.status).toEqual({
			type: 'text',
			value: 'Done'
		});
	});

	it('getRecord reads from the resolved shard', () => {
		const { collectionId } = createSyntheticShardedCollection();
		const record = createRecord(human, {
			parentId: collectionId,
			properties: { a: { type: 'text', value: '1' } }
		});

		expect(getRecord(human, record.id)?.properties?.a).toEqual({ type: 'text', value: '1' });
	});

	it('deleteRecord removes it from the resolved shard and releases its row locator', () => {
		const { collectionId, workspaceId } = createSyntheticShardedCollection();
		const record = createRecord(human, { parentId: collectionId, properties: {} });

		deleteRecord(human, record.id);

		expect(resolveShardForRecord(workspaceId, record.id)).toBeUndefined();
		const { doc: otherDoc } = resolveWorkspaceContext({ workspaceId, shardId: OTHER_SHARD });
		expect(crdtGetRecord(otherDoc, record.id)).toBeUndefined();
	});

	it('holdRecords/releaseRecords (token caller) operate against the resolved shard Awareness, never the default one', () => {
		const { collectionId, workspaceId } = createSyntheticShardedCollection();
		const record = createRecord(human, { parentId: collectionId, properties: {} });

		const { record: tokenRecord } = createToken({
			clientLabel: 'Shard Test Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: [collectionId]
		});

		const holdResult = holdRecords(tokenRecord, [record.id]);
		expect(holdResult).toEqual({ granted: [record.id], denied: [] });

		function isHeldSomewhere(workspaceIdArg: string, shardId: string | undefined): boolean {
			const { awareness } = resolveWorkspaceContext(
				shardId !== undefined
					? { workspaceId: workspaceIdArg, shardId }
					: { workspaceId: workspaceIdArg }
			);
			return Array.from(awareness.getStates().values()).some((s) =>
				(s as { heldRecordIds?: string[] } | undefined)?.heldRecordIds?.includes(record.id)
			);
		}

		expect(isHeldSomewhere(workspaceId, OTHER_SHARD)).toBe(true);
		expect(isHeldSomewhere(workspaceId, undefined)).toBe(false);

		releaseRecords(tokenRecord, [record.id]);
		expect(isHeldSomewhere(workspaceId, OTHER_SHARD)).toBe(false);
	});

	it('searchWorkspace finds content living in the resolved shard, not just the default doc', () => {
		const { collectionId } = createSyntheticShardedCollection();
		createRecord(human, {
			parentId: collectionId,
			properties: { name: { type: 'text', value: 'Findable Needle Value' } }
		});

		const results = searchWorkspace(human, 'needle');
		expect(results.some((r) => r.snippet.includes('Needle'))).toBe(true);
	});
});
