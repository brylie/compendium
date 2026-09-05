import { describe, expect, it } from 'vitest';
import {
	createCollection as rawCrdtCreateCollection,
	createDocument as rawCrdtCreateDocument,
	createRecord as rawCrdtCreateRecord,
	updateRecordContent as rawUpdateRecordContent
} from '$lib/data/records';
import { TEST_ORIGIN, transactWithOrigin } from '$lib/mutation-origin';
import { CURRENT_USER } from './current-user';
import {
	createDocument,
	getDocument,
	listDocuments,
	moveDocument,
	SpaceMismatchError
} from '../services/documents';
import { createCollection, listCollections } from '../services/collections';
import { searchWorkspace } from '../services/search';
import {
	createSpace,
	recordCatalogDocumentCreated,
	reserveDocumentLocator,
	UnknownSpaceError
} from './catalog';
import { logAudit, queryAuditLogForSpace } from './audit';
import { aggregateHolds, clientIdForToken, requestAgentHold } from './holds';
import { resolveWorkspaceContext } from './workspace-store';
import { PermissionDeniedError } from '../services/permissions';
import type { AccessToken } from '$lib/mcp/tokens';

const actor = CURRENT_USER;

function crdtCreateDocument(...args: Parameters<typeof rawCrdtCreateDocument>) {
	return transactWithOrigin(args[0], TEST_ORIGIN, () => rawCrdtCreateDocument(...args));
}

function crdtCreateCollection(...args: Parameters<typeof rawCrdtCreateCollection>) {
	return transactWithOrigin(args[0], TEST_ORIGIN, () => rawCrdtCreateCollection(...args));
}

function crdtCreateRecord(...args: Parameters<typeof rawCrdtCreateRecord>) {
	return transactWithOrigin(args[0], TEST_ORIGIN, () => rawCrdtCreateRecord(...args));
}

function updateRecordContent(...args: Parameters<typeof rawUpdateRecordContent>) {
	return transactWithOrigin(args[0], TEST_ORIGIN, () => rawUpdateRecordContent(...args));
}

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

	it("scoping to the workspace's own default Space still includes uncataloged content (#140 CodeRabbit regression)", () => {
		// Written directly via the CRDT primitive, bypassing the service layer
		// entirely — never gets a catalog/locator row. Before #140's fix, an
		// explicit spaceId filter (even the default Space's own id) skipped the
		// uncataloged fallback unconditionally, silently dropping this content
		// from the sidebar even though it's the workspace's original,
		// pre-multi-Space content and unambiguously belongs to the default Space.
		const { defaultSpaceId } = resolveWorkspaceContext();
		const uncatalogedDoc = crdtCreateDocument(resolveWorkspaceContext().doc, {
			title: 'Legacy Direct-Written Doc'
		});

		const inDefaultSpace = listDocuments(CURRENT_USER, defaultSpaceId);
		expect(inDefaultSpace.map((d) => d.id)).toContain(uncatalogedDoc.id);
	});

	it('scoping to a non-default Space never includes uncataloged content (no regression the other way)', () => {
		const { workspaceId } = resolveWorkspaceContext();
		const spaceB = createSpace(workspaceId, 'Space B');
		crdtCreateDocument(resolveWorkspaceContext().doc, { title: 'Legacy Direct-Written Doc' });

		const inSpaceB = listDocuments(CURRENT_USER, spaceB.id);
		expect(inSpaceB).toEqual([]);
	});

	it('listCollections with no spaceId filter lists a cataloged collection exactly once, plus any uncataloged one', () => {
		const cataloged = createCollection(CURRENT_USER, { title: 'Cataloged Table', schema: [] });
		const uncataloged = crdtCreateCollection(resolveWorkspaceContext().doc, {
			title: 'Legacy Direct-Written Table',
			schema: []
		});

		// listCollections() dedupes against its own catalog fan-out before
		// falling back to a raw Y.Doc scan — without that dedupe, `cataloged`
		// would appear twice (once from the catalog loop, once again from the
		// uncataloged-fallback loop, since every collection also lives in the
		// underlying Y.Doc regardless of how it was created).
		const results = listCollections(CURRENT_USER);
		expect(results.filter((c) => c.id === cataloged.id)).toHaveLength(1);
		expect(results.some((c) => c.id === uncataloged.id)).toBe(true);
	});
});

describe('createDocument/createCollection: Space validation (#140 CodeRabbit)', () => {
	it('createDocument rejects an unknown spaceId instead of letting the FK violation escape', () => {
		expect(() => createDocument(CURRENT_USER, { title: 'X', spaceId: 'not-a-real-space' })).toThrow(
			UnknownSpaceError
		);
	});

	it('createCollection rejects an unknown spaceId the same way', () => {
		expect(() =>
			createCollection(CURRENT_USER, { title: 'X', schema: [], spaceId: 'not-a-real-space' })
		).toThrow(UnknownSpaceError);
	});

	it('createDocument rejects nesting a child under a parent from a different Space', () => {
		const { workspaceId } = resolveWorkspaceContext();
		const spaceB = createSpace(workspaceId, 'Space B');
		const parentInSpaceA = createDocument(CURRENT_USER, { title: 'Parent in A' });

		expect(() =>
			createDocument(CURRENT_USER, {
				title: 'Child in B',
				parentDocumentId: parentInSpaceA.id,
				spaceId: spaceB.id
			})
		).toThrow(SpaceMismatchError);
	});

	it('createDocument allows nesting when the child and parent share the same explicit Space', () => {
		const { defaultSpaceId } = resolveWorkspaceContext();
		const parent = createDocument(CURRENT_USER, { title: 'Parent', spaceId: defaultSpaceId });

		expect(() =>
			createDocument(CURRENT_USER, {
				title: 'Child',
				parentDocumentId: parent.id,
				spaceId: defaultSpaceId
			})
		).not.toThrow();
	});

	it('moveDocument rejects moving a Document under a parent from a different Space', () => {
		const { workspaceId } = resolveWorkspaceContext();
		const spaceB = createSpace(workspaceId, 'Space B');
		const docInSpaceA = createDocument(CURRENT_USER, { title: 'Doc in A' });
		const parentInSpaceB = createDocument(CURRENT_USER, {
			title: 'Parent in B',
			spaceId: spaceB.id
		});

		expect(() =>
			moveDocument(CURRENT_USER, docInSpaceA.id, { parentDocumentId: parentInSpaceB.id })
		).toThrow(SpaceMismatchError);
	});

	it('moveDocument allows moving within the same Space', () => {
		const newParent = createDocument(CURRENT_USER, { title: 'New Parent' });
		const doc = createDocument(CURRENT_USER, { title: 'Doc' });

		expect(() =>
			moveDocument(CURRENT_USER, doc.id, { parentDocumentId: newParent.id })
		).not.toThrow();
	});

	it('createDocument rejects a Space B child nested under a legacy/uncataloged parent (classified as the default Space, not exempt) (#140 CodeRabbit follow-up)', () => {
		// Written directly via the CRDT primitive, bypassing the service layer
		// — no locator row, but it exists in the shared default Y.Doc, so
		// resolveEffectiveDocumentSpaceId classifies it as the default Space,
		// matching listDocuments' own definition of uncataloged content.
		const { workspaceId, defaultSpaceId } = resolveWorkspaceContext();
		const spaceB = createSpace(workspaceId, 'Space B');
		const legacyParent = crdtCreateDocument(resolveWorkspaceContext().doc, {
			title: 'Legacy Default-Space Parent'
		});

		expect(() =>
			createDocument(CURRENT_USER, {
				title: 'Child in B',
				parentDocumentId: legacyParent.id,
				spaceId: spaceB.id
			})
		).toThrow(SpaceMismatchError);

		// The same nesting succeeds when explicitly targeting the default Space
		// the legacy parent actually belongs to.
		expect(() =>
			createDocument(CURRENT_USER, {
				title: 'Child in Default',
				parentDocumentId: legacyParent.id,
				spaceId: defaultSpaceId
			})
		).not.toThrow();
	});

	it('moveDocument rejects moving a legacy/uncataloged default-Space Document under a Space B parent (#140 CodeRabbit follow-up)', () => {
		const { workspaceId } = resolveWorkspaceContext();
		const spaceB = createSpace(workspaceId, 'Space B');
		const legacyDoc = crdtCreateDocument(resolveWorkspaceContext().doc, {
			title: 'Legacy Default-Space Doc'
		});
		const parentInSpaceB = createDocument(CURRENT_USER, {
			title: 'Parent in B',
			spaceId: spaceB.id
		});

		expect(() =>
			moveDocument(CURRENT_USER, legacyDoc.id, { parentDocumentId: parentInSpaceB.id })
		).toThrow(SpaceMismatchError);
	});

	it('createDocument does not throw SpaceMismatchError for a parentDocumentId that does not exist anywhere (unclassifiable, exempt)', () => {
		// Unlike the legacy/uncataloged case above — which still exists in the
		// default Y.Doc and is classified as the default Space —
		// resolveEffectiveDocumentSpaceId returns undefined for an id that
		// can't be found in the catalog *or* the default doc at all, and that
		// case stays exempt from the mismatch check rather than blocking the
		// create outright.
		const { workspaceId } = resolveWorkspaceContext();
		const spaceB = createSpace(workspaceId, 'Space B');

		// Asserts successful creation directly (not just the absence of one
		// specific error type) — `.not.toThrow(SpaceMismatchError)` alone would
		// still pass if this threw some other, unexpected error instead.
		const child = createDocument(CURRENT_USER, {
			title: 'Child of nowhere',
			parentDocumentId: 'not-a-real-parent-id',
			spaceId: spaceB.id
		});
		expect(child.parentDocumentId).toBe('not-a-real-parent-id');
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
			allowedSpaceIds: [],
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

	it('honors a record target filter within the requested Space', () => {
		const { workspaceId, spaceAId, docA, docB } = seedTwoSpaces();
		const entries = queryAuditLogForSpace(workspaceId, spaceAId, { targetRecordId: docA.id });

		expect(entries).not.toHaveLength(0);
		expect(entries.every((entry) => entry.targetRecordId === docA.id)).toBe(true);
		expect(entries.some((entry) => entry.targetRecordId === docB.id)).toBe(false);
	});
});

describe('space isolation: MCP token Space-level allowlists (#6)', () => {
	function tokenScopedToSpace(spaceId: string): AccessToken {
		return {
			tokenHash: 'test-token-space-scoped',
			clientLabel: 'test',
			allowedDocumentIds: [],
			allowedCollectionIds: [],
			allowedSpaceIds: [spaceId],
			createdAt: Date.now()
		};
	}

	it('a token granted only a Space (no per-Document grant) can read every Document in it', () => {
		const { spaceAId, docA } = seedTwoSpaces();
		const token = tokenScopedToSpace(spaceAId);

		expect(getDocument(token, docA.id)?.id).toBe(docA.id);
	});

	it("a token granted Space A cannot read Space B's Document, even by direct id", () => {
		const { spaceAId, docB } = seedTwoSpaces();
		const token = tokenScopedToSpace(spaceAId);

		expect(() => getDocument(token, docB.id)).toThrow(PermissionDeniedError);
	});

	it('listDocuments (unscoped call, no spaceId filter) still only returns the Space-granted Documents for a Space-scoped token', () => {
		const { spaceAId, docA, docB } = seedTwoSpaces();
		const token = tokenScopedToSpace(spaceAId);

		const results = listDocuments(token);
		expect(results.map((d) => d.id)).toContain(docA.id);
		expect(results.map((d) => d.id)).not.toContain(docB.id);
	});

	it('a Space grant does not leak into a different Space even when combined with an explicit per-Document grant elsewhere', () => {
		const { spaceAId, docA, docB } = seedTwoSpaces();
		const token: AccessToken = {
			tokenHash: 'test-token-mixed-grant',
			clientLabel: 'test',
			allowedDocumentIds: [docB.id], // direct grant, unrelated to the Space grant
			allowedCollectionIds: [],
			allowedSpaceIds: [spaceAId],
			createdAt: Date.now()
		};

		// Both grants independently work: Space A via the Space grant, Doc B via
		// its own direct grant — neither one implies unscoped access.
		expect(getDocument(token, docA.id)?.id).toBe(docA.id);
		expect(getDocument(token, docB.id)?.id).toBe(docB.id);
	});

	it('a token granted only the default Space can list legacy/uncataloged content via listDocuments (#141 merge-with-#140 CodeRabbit finding)', () => {
		// Written directly via the CRDT primitive, bypassing the service layer
		// — no locator row, but classified as belonging to defaultSpaceId (see
		// listDocuments' own doc comment). A token with only a Space-level
		// grant for the default Space (no per-Document grant) must still see
		// it — the uncataloged-fallback loop needs to pass defaultSpaceId into
		// tokenAllowsParent, not omit the Space entirely.
		const { defaultSpaceId } = resolveWorkspaceContext();
		const legacyDoc = crdtCreateDocument(resolveWorkspaceContext().doc, {
			title: 'Legacy Default-Space Doc'
		});
		const token = tokenScopedToSpace(defaultSpaceId);

		const results = listDocuments(token);
		expect(results.map((d) => d.id)).toContain(legacyDoc.id);
	});

	it('a token granted only the default Space can list legacy/uncataloged Collections via listCollections', () => {
		const { defaultSpaceId } = resolveWorkspaceContext();
		const legacyCollection = crdtCreateCollection(resolveWorkspaceContext().doc, {
			title: 'Legacy Default-Space Collection',
			schema: []
		});
		const token = tokenScopedToSpace(defaultSpaceId);

		const results = listCollections(token);
		expect(results.map((c) => c.id)).toContain(legacyCollection.id);
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
