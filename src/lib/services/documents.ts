import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import {
	computeSiblingOrder,
	createDocument as crdtCreateDocument,
	createRecord as crdtCreateRecord,
	deleteDocument as crdtDeleteDocument,
	getCollection as crdtGetCollection,
	getDocument as crdtGetDocument,
	listDocuments as crdtListDocuments,
	listRecordsForParent as crdtListRecordsForParent,
	updateDocumentParent as crdtUpdateDocumentParent,
	updateDocumentTitle as crdtUpdateDocumentTitle
} from '$lib/data/records';
import { logAudit } from '$lib/server/audit';
import {
	RecordIdConflictError,
	UnknownSpaceError,
	isKnownSpace,
	listCatalogDocuments,
	recordCatalogDocumentCreated,
	recordCatalogDocumentDeleted,
	recordCatalogDocumentMoved,
	recordCatalogDocumentTitleChanged,
	reserveDocumentLocator,
	resolveShardForParent
} from '$lib/server/catalog';
import { grantDocumentAccess, tokenAllowsParent } from '$lib/mcp/tokens';
import { richTextToMarkdown } from '$lib/mcp/markdown-transcode';
import { resolveInternalLinkTarget, type InternalLinkTarget } from '$lib/data/links';
import type { DocumentMeta, EmbeddedViewConfig, WorkspaceRecord } from '$lib/data/types';
import type * as Y from 'yjs';
import { nanoid } from 'nanoid';
import {
	actorForCaller,
	isAccessToken,
	requireAccessibleParent,
	resolveParentWorkspaceContext,
	type CallerIdentity
} from './permissions';

/** Thrown when creating or moving a Document would place it under a parent belonging to a different Space. */
export class SpaceMismatchError extends Error {
	constructor(parentDocumentId: string) {
		super(`Cannot create a Document in a different Space than its parent (${parentDocumentId})`);
		this.name = 'SpaceMismatchError';
	}
}

/**
 * Resolves the Space a Document effectively belongs to for hierarchy
 * validation — cataloged content uses its real locator spaceId; a
 * *legacy/uncataloged* Document (no locator row) that nonetheless exists in
 * the shared default Y.Doc is classified as `defaultSpaceId`, matching
 * listDocuments' own definition of "uncataloged content belongs to the
 * default Space" (#140 CodeRabbit finding — the earlier version of this
 * check silently exempted uncataloged parents instead, letting a Space B
 * child be created/moved under a default-Space parent undetected). Returns
 * undefined only when the id can't be classified at all (doesn't exist in
 * either place), which stays exempt from the mismatch check.
 */
function resolveEffectiveDocumentSpaceId(
	workspaceId: string,
	documentId: string,
	defaultDoc: ReturnType<typeof resolveWorkspaceContext>['doc'],
	defaultSpaceId: string
): string | undefined {
	const cataloged = resolveShardForParent(workspaceId, documentId)?.spaceId;
	if (cataloged !== undefined) return cataloged;
	return crdtGetDocument(defaultDoc, documentId) ? defaultSpaceId : undefined;
}

export interface CreateDocumentInput {
	id?: string;
	title: string;
	parentDocumentId?: string;
	afterDocumentId?: string;
	createInitialBlock?: boolean;
	spaceId?: string;
}

/**
 * Creates a new Document in its own shard (optionally nested under `input.parentDocumentId`,
 * and optionally seeded with an initial empty block), granting the calling token access to
 * it and auditing the creation. Validates the target Space exists, that a nested parent is
 * accessible and in the same effective Space, and that `input.id` (if supplied) doesn't
 * collide with anything already reachable under that id — in the target shard, or written
 * directly to the default Y.Doc bypassing the service layer (and therefore the catalog
 * locator) entirely.
 */
export function createDocument(caller: CallerIdentity, input: CreateDocumentInput): DocumentMeta {
	const id = input.id ?? nanoid();
	// A Document's shard is its own id — same pattern as createCollection
	// (#120). resolveWorkspaceContext lazily creates the shard on first
	// resolution, so this is safe to call before anything exists there yet.
	const { doc, workspaceId, shardId, defaultSpaceId } = resolveWorkspaceContext({ shardId: id });
	const { doc: defaultDoc } = resolveWorkspaceContext();
	const actor = actorForCaller(caller);
	const targetSpaceId = input.spaceId ?? defaultSpaceId;
	// A caller-supplied spaceId must actually exist — otherwise
	// reserveDocumentLocator's insert below would fail its composite FK
	// against `spaces` and the raw DB exception would escape this call
	// uncaught (#140 CodeRabbit finding, same gap as createCollection's).
	if (input.spaceId !== undefined && !isKnownSpace(workspaceId, input.spaceId)) {
		throw new UnknownSpaceError(input.spaceId);
	}

	// Decision: In single-tenant Phase 0/1, any authenticated caller is permitted
	// to create top-level documents; when nested, access to parentDocumentId is verified.
	if (input.parentDocumentId) {
		requireAccessibleParent(caller, input.parentDocumentId, 'create_document');
		// The parent's effective Space must agree with the target Space —
		// otherwise a child could be created in one Space while nested under a
		// parent that belongs to another (#140 CodeRabbit finding). A legacy
		// parent with no locator row is classified as the default Space (see
		// resolveEffectiveDocumentSpaceId), not silently exempted — only a
		// parent that can't be classified at all (doesn't exist anywhere) is.
		const parentSpaceId = resolveEffectiveDocumentSpaceId(
			workspaceId,
			input.parentDocumentId,
			defaultDoc,
			defaultSpaceId
		);
		if (parentSpaceId !== undefined && parentSpaceId !== targetSpaceId) {
			throw new SpaceMismatchError(input.parentDocumentId);
		}
	}

	// Collision check spans the target shard (a caller-supplied id already
	// used there) and the default doc (content written directly to the Y.Doc,
	// bypassing the service layer and therefore the locator — still possible
	// since the shared 'workspace' room exists for as-yet-unmigrated content).
	// Checked against both maps in the default doc: an id colliding with an
	// existing Collection there wouldn't overwrite it (documents/collections
	// are separate Y.Maps), but would leave it permanently unreachable via
	// parentKindOf, which checks the documents map first.
	if (
		crdtGetDocument(doc, id) ||
		crdtGetDocument(defaultDoc, id) ||
		crdtGetCollection(defaultDoc, id)
	) {
		throw new RecordIdConflictError(id);
	}
	reserveDocumentLocator(workspaceId, targetSpaceId, id, shardId);

	// Sibling order is computed from the catalog, not this doc's own
	// listDocuments(): true siblings can live in entirely different shards
	// once each Document has its own (see computeSiblingOrder's doc comment).
	const siblings = listCatalogDocuments(workspaceId).filter(
		(d) => d.parentDocumentId === input.parentDocumentId
	);
	const order = computeSiblingOrder(siblings, input.afterDocumentId);

	const document = crdtCreateDocument(doc, {
		id,
		title: input.title,
		parentDocumentId: input.parentDocumentId,
		order
	});

	recordCatalogDocumentCreated({
		workspaceId,
		spaceId: targetSpaceId,
		id: document.id,
		title: document.title,
		parentDocumentId: document.parentDocumentId,
		order: document.order,
		shardId
	});

	if (input.createInitialBlock) {
		crdtCreateRecord(doc, { parentId: document.id, blockType: 'paragraph' }, actor);
	}

	// Persist access grant in SQLite so subsequent tool calls from this token succeed
	if (isAccessToken(caller)) {
		grantDocumentAccess(caller.tokenHash, document.id);
		if (!caller.allowedDocumentIds.includes(document.id)) {
			caller.allowedDocumentIds.push(document.id);
		}
	}

	logAudit({ actor, action: 'create_document', targetRecordId: document.id });
	return document;
}

/**
 * Reparents and/or reorders a Document among its siblings, after checking the caller may
 * access both the Document and (when set) its new parent, and that the move wouldn't cross a
 * Space boundary (see SpaceMismatchError). Sibling order is computed from the catalog, not
 * this doc's own record list, since true siblings can each live in a different shard.
 */
export function moveDocument(
	caller: CallerIdentity,
	documentId: string,
	options: { parentDocumentId?: string; afterDocumentId?: string }
): void {
	const { doc, workspaceId } = resolveParentWorkspaceContext(documentId);
	const { doc: defaultDoc, defaultSpaceId } = resolveWorkspaceContext();
	const actor = actorForCaller(caller);

	requireAccessibleParent(caller, documentId, 'move_document');
	if (options.parentDocumentId) {
		requireAccessibleParent(caller, options.parentDocumentId, 'move_document');
		// Same Space-consistency rule as createDocument: moving a Document
		// under a parent in a different Space would silently break the
		// isolation guarantee this feature exists for. Legacy/uncataloged
		// content on either side is classified as the default Space (see
		// resolveEffectiveDocumentSpaceId), not silently exempted.
		const documentSpaceId = resolveEffectiveDocumentSpaceId(
			workspaceId,
			documentId,
			defaultDoc,
			defaultSpaceId
		);
		const newParentSpaceId = resolveEffectiveDocumentSpaceId(
			workspaceId,
			options.parentDocumentId,
			defaultDoc,
			defaultSpaceId
		);
		if (
			documentSpaceId !== undefined &&
			newParentSpaceId !== undefined &&
			documentSpaceId !== newParentSpaceId
		) {
			throw new SpaceMismatchError(options.parentDocumentId);
		}
	}

	// Catalog-sourced siblings, not doc's own listDocuments() — see
	// createDocument's identical reasoning.
	const siblings = listCatalogDocuments(workspaceId).filter(
		(d) => d.id !== documentId && d.parentDocumentId === options.parentDocumentId
	);
	const order = computeSiblingOrder(siblings, options.afterDocumentId);

	crdtUpdateDocumentParent(
		doc,
		documentId,
		options.parentDocumentId,
		options.afterDocumentId,
		order
	);
	recordCatalogDocumentMoved(workspaceId, documentId, options.parentDocumentId, order);
	logAudit({
		actor,
		action: 'move_document',
		targetRecordId: documentId,
		diff: options
	});
}

/** Walks the catalog's own parent chain (not a Y.Doc) to find every descendant of rootId, since descendants can each live in a different shard — mirrors catalog.ts's recordCatalogDocumentDeleted recursive CTE, one level up. */
function collectDescendantIds(allDocs: DocumentMeta[], rootId: string): string[] {
	const ids = [rootId];
	const stack = [rootId];
	while (stack.length > 0) {
		const current = stack.pop()!;
		for (const candidate of allDocs) {
			if (candidate.parentDocumentId === current) {
				ids.push(candidate.id);
				stack.push(candidate.id);
			}
		}
	}
	return ids;
}

/**
 * Deletes a Document and its entire descendant subtree (after a single permission check on
 * the root), removing each descendant from its own shard's Y.Doc — descendants are found by
 * walking the catalog's parent chain, the only place the full cross-shard tree is visible —
 * then cascades the deletion in the catalog and audits it once for the root.
 */
export function deleteDocument(caller: CallerIdentity, documentId: string): void {
	const { workspaceId } = resolveParentWorkspaceContext(documentId);
	const actor = actorForCaller(caller);

	requireAccessibleParent(caller, documentId, 'delete_document');

	// Each descendant's own shard contains only that Document, so calling the
	// existing recursive crdtDeleteDocument against it is automatically
	// non-recursive in practice (its internal child-lookup finds nothing in
	// an isolated shard) — recursion instead happens here, over the catalog,
	// which is the only place the full cross-shard tree is visible.
	const descendantIds = collectDescendantIds(listCatalogDocuments(workspaceId), documentId);
	for (const id of descendantIds) {
		const { doc } = resolveParentWorkspaceContext(id);
		crdtDeleteDocument(doc, id);
	}

	// One call cascades the whole subtree — recordCatalogDocumentDeleted
	// already walks its own recursive CTE (catalog.ts).
	recordCatalogDocumentDeleted(workspaceId, documentId);
	logAudit({ actor, action: 'delete_document', targetRecordId: documentId });
}

/** Renames a Document (after a permission check), updating both the Y.Doc and the catalog, and audits the change. */
export function updateDocumentTitle(
	caller: CallerIdentity,
	documentId: string,
	title: string
): void {
	const { doc, workspaceId } = resolveParentWorkspaceContext(documentId);
	const actor = actorForCaller(caller);

	requireAccessibleParent(caller, documentId, 'update_document_title');
	crdtUpdateDocumentTitle(doc, documentId, title);
	recordCatalogDocumentTitleChanged(workspaceId, documentId, title);
	logAudit({
		actor,
		action: 'update_document_title',
		targetRecordId: documentId,
		diff: { title }
	});
}

interface DocumentRecordView {
	id: string;
	blockType?: string;
	checked?: boolean;
	collapsed?: boolean;
	referencedRecordId?: string;
	// True when referencedRecordId is set but no longer names an existing
	// Document/Collection — the target was deleted after this page_link was
	// created. Exposed as its own field (not just inferred from markdown
	// text) so callers, including MCP agents, can detect a broken link
	// without string-matching "Deleted page". See
	// docs/specifications/internal-links.md.
	linkBroken?: boolean;
	// Only set for collection_view blocks, and only when the target
	// Collection is in scope — same omission rule as referencedRecordId,
	// since it names properties/filters from a Collection whose schema an
	// out-of-scope caller was never granted visibility into either.
	viewConfig?: EmbeddedViewConfig;
	markdown: string;
}

interface ResolvedLink {
	targetInScope: boolean;
	// undefined here covers both "not a linking block type" and "linking
	// block whose target didn't resolve" — linkBroken (below) is what tells
	// those two apart for the caller.
	linkedTarget: InternalLinkTarget | undefined;
	linkBroken: true | undefined;
}

// A referenced target can be any Document or Collection, not just ones
// under this documentId — an out-of-scope target must not leak its
// title/id/schema to a token that was never granted access to it. Only
// page_link/collection_view blocks have a target to resolve at all.
function resolveRecordLink(
	r: WorkspaceRecord,
	doc: Y.Doc,
	workspaceId: string,
	caller: CallerIdentity,
	isPageLink: boolean,
	isCollectionView: boolean
): ResolvedLink {
	const targetInScope =
		!r.referencedRecordId ||
		!isAccessToken(caller) ||
		tokenAllowsParent(
			caller,
			r.referencedRecordId,
			resolveShardForParent(workspaceId, r.referencedRecordId)?.spaceId
		);
	// The reference target can be a Document (unsharded, always in `doc`)
	// or a Collection (its own shard, possibly a different doc entirely).
	// Try `doc` itself first, then fall back to resolving its real shard.
	const resolvedTarget =
		(isPageLink || isCollectionView) && r.referencedRecordId && targetInScope
			? (resolveInternalLinkTarget(doc, r.referencedRecordId) ??
				resolveInternalLinkTarget(
					resolveParentWorkspaceContext(r.referencedRecordId).doc,
					r.referencedRecordId
				))
			: undefined;
	// collection_view's target must resolve to a Collection specifically
	// (page_link's own read side already enforces the equivalent
	// Document-kind check via internal-links.md §1) — a target that
	// resolved but is the wrong kind is treated the same as unresolved.
	const linkedTarget =
		isCollectionView && resolvedTarget?.kind !== 'collection' ? undefined : resolvedTarget;
	const linkBroken: true | undefined =
		(isPageLink || isCollectionView) && r.referencedRecordId && targetInScope && !linkedTarget
			? true
			: undefined;
	return { targetInScope, linkedTarget, linkBroken };
}

function renderRecordMarkdown(
	r: WorkspaceRecord,
	doc: Y.Doc,
	isPageLink: boolean,
	isCollectionView: boolean,
	link: ResolvedLink
): string {
	if (isPageLink) {
		if (r.referencedRecordId && link.targetInScope) {
			return `[[${link.linkedTarget?.title ?? 'Deleted page'}]]`;
		}
		return r.content ? richTextToMarkdown(doc, r.content) : '';
	}
	if (isCollectionView) {
		return r.referencedRecordId && link.targetInScope
			? `[collection view: ${link.linkedTarget?.title ?? 'Deleted collection'}]`
			: '[collection view: unconfigured]';
	}
	return r.content ? richTextToMarkdown(doc, r.content) : '';
}

// The per-record half of getDocument's job: resolve a page_link/
// collection_view's target (permission-scoped), and render the block's
// markdown accordingly. Split out because this — not the surrounding
// fetch/audit/reshape in getDocument itself — is where nearly all of that
// function's own complexity actually lived.
function resolveDocumentRecordView(
	r: WorkspaceRecord,
	doc: Y.Doc,
	workspaceId: string,
	caller: CallerIdentity
): DocumentRecordView {
	const isPageLink = r.blockType === 'page_link';
	const isCollectionView = r.blockType === 'collection_view';
	const link = resolveRecordLink(r, doc, workspaceId, caller, isPageLink, isCollectionView);
	const markdown = renderRecordMarkdown(r, doc, isPageLink, isCollectionView, link);
	return {
		id: r.id,
		blockType: r.blockType,
		checked: r.checked,
		collapsed: r.collapsed,
		referencedRecordId: link.targetInScope ? r.referencedRecordId : undefined,
		linkBroken: link.linkBroken,
		viewConfig: isCollectionView && link.linkedTarget ? r.viewConfig : undefined,
		markdown
	};
}

/**
 * Returns a Document's title and its blocks rendered to markdown, after checking the caller
 * may access it. Each `page_link`/`collection_view` block's target is resolved and permission-
 * scoped independently (a referenced target can be any Document/Collection, not just ones
 * under this Document, so an out-of-scope target's title/id/schema must not leak) — a deleted
 * target renders as a generic placeholder, and an out-of-scope target falls back to the
 * block's own content (`page_link`) or an unconfigured placeholder (`collection_view`); the
 * target itself is never exposed either way, and `linkBroken` distinguishes "target no longer
 * exists" from "not a linking block" for
 * callers that need to tell the two apart.
 */
export function getDocument(
	caller: CallerIdentity,
	documentId: string
): {
	id: string;
	title: string;
	parentDocumentId?: string;
	records: DocumentRecordView[];
} | null {
	const { doc, workspaceId } = resolveParentWorkspaceContext(documentId);
	const actor = actorForCaller(caller);

	requireAccessibleParent(caller, documentId, 'get_document');
	const document = crdtGetDocument(doc, documentId);
	if (!document) return null;

	const records = crdtListRecordsForParent(doc, documentId).map((r) =>
		resolveDocumentRecordView(r, doc, workspaceId, caller)
	);

	logAudit({ actor, action: 'get_document', targetRecordId: documentId });
	return {
		id: document.id,
		title: document.title,
		parentDocumentId: document.parentDocumentId,
		records
	};
}

/**
 * `spaceId` is optional and additive — omitted, this is exactly today's
 * behavior (every Document in the workspace, catalog plus uncataloged
 * fallback). Passed a *non-default* Space, results are strictly
 * catalog-scoped to it: the uncataloged fallback is skipped entirely, since
 * content not yet in the catalog has no reliably known Space membership to
 * check (see #132's migration, which is what actually gives such content a
 * real spaceId) — silently guessing it belongs to the requested Space would
 * be exactly the kind of leak #133 exists to close. Passed the workspace's
 * own `defaultSpaceId`, the fallback still runs: uncataloged content is, by
 * definition, everything that existed before Spaces did, so it belongs
 * exactly there, not to a genuinely ambiguous Space — treating it as absent
 * from the default Space's own view would silently drop legacy/direct-Yjs
 * content from the sidebar (#140 CodeRabbit finding).
 */
export function listDocuments(caller: CallerIdentity, spaceId?: string): DocumentMeta[] {
	const { workspaceId, defaultSpaceId, doc: defaultDoc } = resolveWorkspaceContext();
	const allowed = (id: string, docSpaceId?: string) =>
		!isAccessToken(caller) || tokenAllowsParent(caller, id, docSpaceId);

	const catalogDocs = listCatalogDocuments(workspaceId, spaceId);
	const catalogDocumentIds = new Set(catalogDocs.map((d) => d.id));
	const results = catalogDocs.filter((d) => allowed(d.id, d.spaceId));

	if (spaceId !== undefined && spaceId !== defaultSpaceId) return results;

	// Then any Document written directly to the Y.Doc, bypassing the service
	// layer entirely (and therefore uncataloged) — mirrors listCollections'
	// identical catalog-then-uncataloged-fallback union pattern.
	for (const document of crdtListDocuments(defaultDoc)) {
		if (catalogDocumentIds.has(document.id)) continue;
		// Uncataloged content is classified as belonging to defaultSpaceId (see
		// this function's own doc comment) — passing it here too, not just
		// omitting it, so a token whose only grant is a Space-level allowlist
		// for the default Space (no per-Document grant) can actually see it
		// (CodeRabbit finding on #141's merge with #140).
		if (!allowed(document.id, defaultSpaceId)) continue;
		results.push(document);
	}

	return results;
}
