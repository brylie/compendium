import { describe, expect, it } from 'vitest';
import {
	createDocument as crdtCreateDocument,
	createRecord as crdtCreateRecord,
	updateRecordContent
} from '$lib/data/records';
import { CURRENT_USER } from './current-user';
import { createDocument, listDocuments } from '../services/documents';
import { createCollection, listCollections } from '../services/collections';
import { searchWorkspace } from '../services/search';
import { createSpace, recordCatalogDocumentCreated, reserveDocumentLocator } from './catalog';
import { logAudit, queryAuditLogForSpace } from './audit';
import { aggregateHolds, clientIdForToken, requestAgentHold } from './holds';
import { resolveWorkspaceContext } from './workspace-store';
import type { AccessToken } from '$lib/mcp/tokens';

const actor = CURRENT_USER;

// Two-Space fixture (#114/#133, workspace-sharding.md §9): Space A content
// goes through the real service layer (which always writes to
// resolveWorkspaceContext()'s defaultSpaceId — Space A here), Space B
// content is seeded via the same lower-level catalog+CRDT primitives
// createDocument itself uses internally, just targeting spaceB's id instead —
// there's no product-facing "create in a specific Space" API yet (that's
// #6's job), so this is the only way to construct a genuine second Space
// today, matching #133's own explicit non-goal.
function seedTwoSpaces() {
	const { workspaceId, defaultSpaceId: spaceAId } = resolveWorkspaceContext();
	const spaceB = createSpace(workspaceId, 'Space B');

	const docA = createDocument(CURRENT_USER, { title: 'Space A Doc' });
	const collectionA = createCollection(CURRENT_USER, { title: 'Space A Table', schema: [] });

	const docBShard = resolveWorkspaceContext({ workspaceId, shardId: 'space-b-doc' });
	const docB = crdtCreateDocument(docBShard.doc, { id: 'space-b-doc', title: 'Space B Doc' });
	reserveDocumentLocator(workspaceId, spaceB.id, docB.id, docBShard.shardId);
	recordCatalogDocumentCreated({
		workspaceId,
		spaceId: spaceB.id,
		id: docB.id,
		title: docB.title,
		order: docB.order,
		shardId: docBShard.shardId
	});
	logAudit({ actor, action: 'create_document', targetRecordId: docB.id });

	return { workspaceId, spaceAId, spaceBId: spaceB.id, docA, collectionA, docB, docBShard };
}

describe('space isolation: listDocuments/listCollections (#133, workspace-sharding.md §9)', () => {
	it("scopes to the requested Space and never returns the other Space's Documents", () => {
		const { spaceAId, spaceBId, docA, docB } = seedTwoSpaces();

		const inSpaceA = listDocuments(CURRENT_USER, spaceAId);
		expect(inSpaceA.map((d) => d.id)).toContain(docA.id);
		expect(inSpaceA.map((d) => d.id)).not.toContain(docB.id);

		const inSpaceB = listDocuments(CURRENT_USER, spaceBId);
		expect(inSpaceB.map((d) => d.id)).toContain(docB.id);
		expect(inSpaceB.map((d) => d.id)).not.toContain(docA.id);
	});

	it('with no spaceId, keeps returning every Document in the workspace (back-compat)', () => {
		const { docA, docB } = seedTwoSpaces();

		const all = listDocuments(CURRENT_USER);
		expect(all.map((d) => d.id)).toContain(docA.id);
		expect(all.map((d) => d.id)).toContain(docB.id);
	});

	it('treats an explicitly-passed empty spaceId as a real (non-matching) scope, not "no filter"', () => {
		// Regression: an empty string is a supplied value, `undefined` is
		// omission — conflating the two (a truthiness check instead of
		// `!== undefined`) would silently fall through to unscoped,
		// workspace-wide results for a caller that *did* pass something.
		const { docA, docB } = seedTwoSpaces();

		const results = listDocuments(CURRENT_USER, '');
		expect(results).toEqual([]);
		expect(results.map((d) => d.id)).not.toContain(docA.id);
		expect(results.map((d) => d.id)).not.toContain(docB.id);
	});

	it('scopes Collections to the requested Space the same way', () => {
		const { spaceAId, spaceBId, collectionA } = seedTwoSpaces();

		const inSpaceA = listCollections(CURRENT_USER, spaceAId);
		expect(inSpaceA.map((c) => c.id)).toContain(collectionA.id);

		const inSpaceB = listCollections(CURRENT_USER, spaceBId);
		expect(inSpaceB.map((c) => c.id)).not.toContain(collectionA.id);
	});
});

describe('space isolation: searchWorkspace never crosses a Space boundary', () => {
	it('finds a match in the requested Space but not the other one, even when both contain matching text', () => {
		const { spaceAId, spaceBId, docA, docB, docBShard } = seedTwoSpaces();

		const { doc: docADoc } = resolveWorkspaceContext({
			workspaceId: resolveWorkspaceContext().workspaceId,
			shardId: docA.id
		});
		const blockA = crdtCreateRecord(docADoc, { parentId: docA.id, blockType: 'paragraph' }, actor);
		updateRecordContent(
			docADoc,
			blockA.id,
			{ runs: [{ text: 'unicornsparkle', marks: {} }] },
			actor
		);

		const blockB = crdtCreateRecord(
			docBShard.doc,
			{ parentId: docB.id, blockType: 'paragraph' },
			actor
		);
		updateRecordContent(
			docBShard.doc,
			blockB.id,
			{ runs: [{ text: 'unicornsparkle', marks: {} }] },
			actor
		);

		const resultsInA = searchWorkspace(CURRENT_USER, 'unicornsparkle', spaceAId);
		expect(resultsInA.map((r) => r.recordId)).toContain(blockA.id);
		expect(resultsInA.map((r) => r.recordId)).not.toContain(blockB.id);

		const resultsInB = searchWorkspace(CURRENT_USER, 'unicornsparkle', spaceBId);
		expect(resultsInB.map((r) => r.recordId)).toContain(blockB.id);
		expect(resultsInB.map((r) => r.recordId)).not.toContain(blockA.id);
	});

	it('composes with token document-ID scoping: a token confined to Space A gets nothing when the query itself is scoped to Space B', () => {
		const { spaceBId, docA } = seedTwoSpaces();
		const token: AccessToken = {
			tokenHash: 'test-token-space-a',
			clientLabel: 'test',
			allowedDocumentIds: [docA.id],
			allowedCollectionIds: [],
			createdAt: Date.now()
		};

		// The token is scoped to Space A's own document, but the query itself
		// asks for Space B — the space filter and the per-ID token filter are
		// two independent gates, and both must agree.
		const results = searchWorkspace(token, 'Space', spaceBId);
		expect(results).toEqual([]);
	});
});

describe('space isolation: audit history', () => {
	it("queryAuditLogForSpace never surfaces another Space's entries", () => {
		const { workspaceId, spaceAId, spaceBId, docA, docB } = seedTwoSpaces();

		const spaceAEntries = queryAuditLogForSpace(workspaceId, spaceAId);
		expect(spaceAEntries.some((e) => e.targetRecordId === docA.id)).toBe(true);
		expect(spaceAEntries.some((e) => e.targetRecordId === docB.id)).toBe(false);

		const spaceBEntries = queryAuditLogForSpace(workspaceId, spaceBId);
		expect(spaceBEntries.some((e) => e.targetRecordId === docB.id)).toBe(true);
		expect(spaceBEntries.some((e) => e.targetRecordId === docA.id)).toBe(false);
	});
});

describe('space isolation: holds/Awareness never cross a Space boundary (regression, not new behavior)', () => {
	it("a hold on a Space A Document's block is invisible on a Space B Document's own Awareness", () => {
		const { docA, docBShard } = seedTwoSpaces();

		const { awareness: awarenessA } = resolveWorkspaceContext({
			workspaceId: resolveWorkspaceContext().workspaceId,
			shardId: docA.id
		});
		const clientId = clientIdForToken('test-token');
		requestAgentHold(
			awarenessA,
			clientId,
			{ kind: 'agent', agentId: 'a1', name: 'Test Agent' },
			[docA.id],
			() => true
		);

		expect(aggregateHolds(awarenessA).size).toBe(1);
		// This is already true structurally (each Document has always had its
		// own real Awareness/Y.Doc since #113/#130) — asserted here as
		// documented Space-isolation coverage, not a new mechanism.
		expect(aggregateHolds(docBShard.awareness).size).toBe(0);
	});
});
