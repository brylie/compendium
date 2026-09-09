import { nanoid } from 'nanoid';
import { SERVICE_ORIGIN, transactWithOrigin } from '../mutation-origin.js';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { clientIdForToken, isHeldByClient, releaseAgentHold } from '$lib/server/holds';
import { getDocument as crdtGetDocument } from '$lib/data/document-ops';
import {
	createColumnsBlock as crdtCreateColumnsBlock,
	createRecord as crdtCreateRecord,
	deleteRecord as crdtDeleteRecord,
	getRecord as crdtGetRecord,
	getRecordYText,
	MAX_COLUMN_COUNT,
	MIN_COLUMN_COUNT,
	parentKindOf,
	patchRecordViewConfig as crdtPatchRecordViewConfig,
	setRecordBookmarkMetadata as crdtSetRecordBookmarkMetadata,
	setRecordReferencedId as crdtSetRecordReferencedId,
	setRecordViewConfig as crdtSetRecordViewConfig,
	updateRecordContent,
	updateRecordProperties
} from '$lib/data/record-ops';
import { resolveInternalLinkTarget } from '$lib/data/links';
import { logAudit } from '$lib/server/audit';
import { reserveRecordLocator, releaseRecordLocator } from '$lib/server/catalog';
import { fetchLinkPreviewMetadata } from '$lib/server/link-preview';
import { markdownToRichText } from '$lib/data/markdown-transcode';
import { yTextToRichText } from '$lib/data/richtext';
import { tokenAllowsParent } from '$lib/server/token-store';
import {
	columnChildBlockTypes,
	type BlockType,
	type BookmarkMetadata,
	type ChildPagesDepth,
	type EmbeddedViewConfig,
	type PropertyValue,
	type ViewConfig,
	type ViewType,
	type WorkspaceRecord
} from '$lib/data/types';
import {
	actorForCaller,
	isAccessToken,
	requireAccessibleParent,
	requireAccessibleRecord,
	requireAccessibleRecordInDoc,
	resolveOwningParentId,
	resolveParentWorkspaceContext,
	resolveRecordWorkspaceContext,
	type CallerIdentity
} from './permissions';

/** Thrown when an agent caller tries to write a record's content without first holding it via `hold_records`. */
export class HoldRequiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HoldRequiredError';
	}
}

/**
 * Thrown when a `page_link`/`child_pages` block's target isn't a Document, or a
 * `collection_view` block's target isn't a Collection, that the caller can already reach.
 * Deliberately a single generic message per kind for "doesn't exist" and "exists but out of
 * token scope" alike, so a probing caller can't use this as an oracle to learn whether a given
 * ID exists (docs/specifications/internal-links.md §4, audit-coverage.md §3's "never leak more
 * than what the caller already supplied" principle).
 */
export class InvalidLinkTargetError extends Error {
	constructor(targetId: string, kind: 'Document' | 'Collection' = 'Document') {
		super(
			kind === 'Document'
				? `${targetId} is not an accessible Document — page_link/child_pages can only target one.`
				: `${targetId} is not an accessible Collection — collection_view can only target one.`
		);
		this.name = 'InvalidLinkTargetError';
	}
}

// Both block types' referencedRecordId must resolve to an existing,
// caller-accessible Document (never a Collection) — page_link's target is
// always required to be one, and child_pages' explicit target (when set at
// all; it's optional there) is one too.
const DOCUMENT_REFERENCE_BLOCK_TYPES: readonly BlockType[] = ['page_link', 'child_pages'];

const REFERENCE_TARGET_ERROR_KIND = { document: 'Document', collection: 'Collection' } as const;

/**
 * Validates a `referencedRecordId` against the target kind its block type
 * requires — `document` for page_link/child_pages, `collection` for
 * collection_view (mirrors the `linkedTarget?.kind === 'collection'` check
 * the read side already applies, services/documents.ts's resolveRecordLink,
 * closing the write-side gap tracked by issue #37). Built on
 * `resolveInternalLinkTarget` (src/lib/data/links.ts) rather than a direct
 * `crdtGetDocument`/`crdtGetCollection` call, so "does this ID exist, and as
 * which kind" is answered in one shared place instead of reimplemented per
 * kind (issue #62).
 */
function validateReferenceTarget(
	caller: CallerIdentity,
	targetId: string,
	kind: 'document' | 'collection'
): void {
	// The target has its own real shard (#120) — resolveParentWorkspaceContext
	// finds it via the catalog locator, falling back to the default doc for an
	// untracked/legacy target.
	const { doc, parentSpaceId } = resolveParentWorkspaceContext(targetId);
	const target = resolveInternalLinkTarget(doc, targetId);
	const errorKind = REFERENCE_TARGET_ERROR_KIND[kind];
	if (target?.kind !== kind) throw new InvalidLinkTargetError(targetId, errorKind);
	if (isAccessToken(caller) && !tokenAllowsParent(caller, targetId, parentSpaceId)) {
		throw new InvalidLinkTargetError(targetId, errorKind);
	}
}

/**
 * The shared guard shape behind every page_link/child_pages/collection_view
 * `referencedRecordId` check: the record's own parent must be a Document
 * (both block types below only ever exist inside one), and the target must
 * resolve to the given kind and be caller-accessible. `createRecord`'s and
 * `writeRecord`'s validators (below) differ only in which block types they
 * accept and their error wording — that difference is real (writeRecord
 * doesn't support retargeting child_pages, whose target is UI-only post-
 * creation) and stays in each of them; this is just their shared middle step
 * (issue #62).
 */
function requireParentDocumentThenValidateTarget(
	caller: CallerIdentity,
	doc: Y.Doc,
	parentId: string,
	targetId: string,
	kind: 'document' | 'collection',
	parentErrorMessage: string
): void {
	if (!crdtGetDocument(doc, parentId)) throw new Error(parentErrorMessage);
	validateReferenceTarget(caller, targetId, kind);
}

const VIEW_TYPES: readonly ViewType[] = ['table', 'board', 'calendar'];

/** Validates a `collection_view` block's `viewConfig` — only accepted on that block type, and only with a recognized `viewType`. Deeper member shape (filters/sort/etc.) is left to the MCP-boundary zod schema, the same depth every other structured MCP input (e.g. `properties`) is validated at. */
function validateViewConfig(
	blockType: BlockType | undefined,
	viewConfig: EmbeddedViewConfig
): void {
	if (blockType !== 'collection_view') {
		throw new Error('viewConfig is only valid on a collection_view block.');
	}
	if (!VIEW_TYPES.includes(viewConfig.viewType)) {
		throw new Error('viewConfig.viewType must be "table", "board", or "calendar".');
	}
}

/**
 * Validates a `collection_view` block's `viewConfigPatch` (issue #195) — same block-type
 * restriction as `viewConfig`, plus a check `viewConfig` doesn't need: the block must already be
 * configured (have a `viewType`), since patching an unconfigured block would silently write
 * orphaned `filters`/`sort`/etc. entries that `readViewConfig` won't surface until a `viewType`
 * is eventually set (see view-config.ts's `readViewConfig`). Use `viewConfig` for the initial
 * configure. `viewType` itself can't appear in a patch — enforced at the MCP schema boundary
 * (`viewConfigPatchSchema` has no `viewType` field) and again at runtime by
 * `patchRecordViewConfig`, so not re-checked here.
 */
function validateViewConfigPatch(
	blockType: BlockType | undefined,
	existingViewConfig: EmbeddedViewConfig | undefined
): void {
	if (blockType !== 'collection_view') {
		throw new Error('viewConfigPatch is only valid on a collection_view block.');
	}
	if (!existingViewConfig) {
		throw new Error(
			'viewConfigPatch requires the collection_view block to already be configured — use viewConfig for the initial configure.'
		);
	}
}

/** Validates a `columns` block's initial `columnCount` (issue #148) — only accepted alongside that block type, and bounded to the same 2-6 range record-ops.ts's own createColumnsBlock/createRecord/deleteRecord enforce at every mutation path, not just this initial one. */
function validateColumnCount(blockType: BlockType | undefined, columnCount: number): void {
	if (blockType !== 'columns') {
		throw new Error('columnCount is only valid on a columns block.');
	}
	if (
		!Number.isSafeInteger(columnCount) ||
		columnCount < MIN_COLUMN_COUNT ||
		columnCount > MAX_COLUMN_COUNT
	) {
		throw new Error(
			`columnCount must be an integer between ${MIN_COLUMN_COUNT} and ${MAX_COLUMN_COUNT}.`
		);
	}
}

/**
 * Validates that `blockType` is actually creatable under `parentId`'s
 * resolved kind (issue #148's columns/column nesting rules) — a `columns`
 * block only directly inside a Document (no nested columns-in-columns), a
 * `column` only directly inside an existing `columns` block, and every other
 * block type either directly inside a Document (unchanged, pre-#148
 * behavior) or inside a `column`, where only the curated
 * `columnChildBlockTypes` subset is allowed — a column's own mini
 * block-list renderer (ColumnsBlock.svelte) only knows how to render that
 * subset; reference/structural/container types stay Document-only for v1.
 */
function validateBlockTypeForParent(doc: Y.Doc, parentId: string, blockType: BlockType): void {
	const kind = parentKindOf(doc, parentId);
	if (blockType === 'columns') {
		if (kind !== 'document') {
			throw new Error('columns blocks can only be created directly inside a Document.');
		}
		return;
	}
	if (blockType === 'column') {
		const parent = kind === 'record' ? crdtGetRecord(doc, parentId) : undefined;
		if (parent?.blockType !== 'columns') {
			throw new Error('column blocks can only be created directly inside a columns block.');
		}
		return;
	}
	if (kind !== 'record') return; // ordinary Document-level block — unchanged, pre-#148 behavior
	const parent = crdtGetRecord(doc, parentId);
	const allowed: readonly BlockType[] = columnChildBlockTypes;
	if (parent?.blockType !== 'column' || !allowed.includes(blockType)) {
		throw new Error(
			`${blockType} blocks cannot be created inside a column — supported column content is ${columnChildBlockTypes.join(', ')}.`
		);
	}
}

/** Validates a bookmark block's initial `url` (issue #155) — only accepted alongside that block type, and restricted to http(s) so a bookmark can never be created pointing at a scheme the server-side preview fetch (fetchLinkPreviewMetadata, $lib/server/link-preview.ts) would reject anyway. */
function validateBookmarkUrl(blockType: BlockType | undefined, url: string): void {
	if (blockType !== 'bookmark') {
		throw new Error('url is only valid on a bookmark block.');
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error('url must be an absolute http(s) URL.');
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error('url must be an absolute http(s) URL.');
	}
}

function validateChildPagesDepth(depth: ChildPagesDepth): void {
	if (depth === 'unlimited') return;
	if (!Number.isSafeInteger(depth) || depth < 1) {
		throw new Error('childPagesDepth must be a positive integer or "unlimited".');
	}
}

// Extracted from createRecord purely to keep that function's cognitive
// complexity down — this is still exactly its referencedRecordId branch,
// not a reusable rule applied elsewhere (create_record is the only place a
// referencedRecordId is set alongside a fresh blockType; writeRecord's
// retarget path already knows its record's existing blockType, so it has
// its own, differently-shaped validateReferencedRecordIdWrite below).
function validateCreateReferencedRecordId(
	caller: CallerIdentity,
	doc: Y.Doc,
	parentId: string,
	blockType: BlockType | undefined,
	referencedRecordId: string
): void {
	if (blockType && DOCUMENT_REFERENCE_BLOCK_TYPES.includes(blockType)) {
		requireParentDocumentThenValidateTarget(
			caller,
			doc,
			parentId,
			referencedRecordId,
			'document',
			'page_link and child_pages blocks can only be created inside a Document.'
		);
		return;
	}
	if (blockType === 'collection_view') {
		requireParentDocumentThenValidateTarget(
			caller,
			doc,
			parentId,
			referencedRecordId,
			'collection',
			'collection_view blocks can only be created inside a Document.'
		);
		return;
	}
	throw new Error(
		'referencedRecordId is only valid on a page_link, child_pages, or collection_view block.'
	);
}

interface CreateRecordServiceInput {
	parentId: string;
	afterRecordId?: string;
	blockType?: BlockType;
	properties?: Record<string, PropertyValue>;
	referencedRecordId?: string;
	viewConfig?: EmbeddedViewConfig;
	childPagesDepth?: ChildPagesDepth;
	columnCount?: number; // for columns blocks only (issue #148) — default 2
	url?: string; // for bookmark blocks only (issue #155)
}

// Extracted from createRecord purely to keep its own cognitive complexity
// down (the same reason validateCreateReferencedRecordId above was already
// split out) — every up-front rejection createRecord needs before it
// reserves a locator or writes anything, in one place.
function validateCreateRecordInput(
	caller: CallerIdentity,
	doc: Y.Doc,
	input: CreateRecordServiceInput
): void {
	// The CRDT layer intentionally stores Collection children as rows, dropping
	// blockType. Reject every explicitly requested block here instead of
	// reporting a successful create_record that silently produced a row.
	const parentKind = parentKindOf(doc, input.parentId);
	if (input.blockType !== undefined && parentKind !== 'document' && parentKind !== 'record') {
		throw new Error('blockType is only valid when creating a record inside a Document.');
	}

	if (input.blockType !== undefined) {
		validateBlockTypeForParent(doc, input.parentId, input.blockType);
	}

	if (input.referencedRecordId !== undefined) {
		validateCreateReferencedRecordId(
			caller,
			doc,
			input.parentId,
			input.blockType,
			input.referencedRecordId
		);
	}

	if (input.viewConfig !== undefined) {
		validateViewConfig(input.blockType, input.viewConfig);
	}

	if (input.childPagesDepth !== undefined) {
		if (input.blockType !== 'child_pages') {
			throw new Error('childPagesDepth is only valid on a child_pages block.');
		}
		validateChildPagesDepth(input.childPagesDepth);
	}

	if (input.columnCount !== undefined) {
		validateColumnCount(input.blockType, input.columnCount);
	}

	if (input.url !== undefined) {
		validateBookmarkUrl(input.blockType, input.url);
	}
}

// The actual CRDT write createRecord performs, split out so the try/catch
// around it (and the locator bookkeeping around *that*) doesn't also have to
// carry this branch's own complexity inline.
function performCreateRecord(
	doc: Y.Doc,
	id: string,
	input: CreateRecordServiceInput,
	actor: ReturnType<typeof actorForCaller>
): WorkspaceRecord {
	if (input.blockType === 'columns') {
		return crdtCreateColumnsBlock(
			doc,
			{ id, parentId: input.parentId, afterRecordId: input.afterRecordId },
			actor,
			input.columnCount
		);
	}
	return crdtCreateRecord(
		doc,
		{
			id,
			parentId: input.parentId,
			afterRecordId: input.afterRecordId,
			blockType: input.blockType,
			properties: input.properties,
			referencedRecordId: input.referencedRecordId,
			viewConfig: input.viewConfig,
			childPagesDepth: input.childPagesDepth,
			url: input.url,
			// Set immediately so the record is never missing a status once a url
			// is present — the MCP tool handler (server.ts) awaits
			// refreshBookmarkMetadata right after this call and replaces it with
			// the real fetch result before responding to the caller; a UI-created
			// bookmark (direct client mutation, bypassing this service entirely)
			// sets this itself the same way (BookmarkBlock.svelte).
			bookmarkMetadata: input.url ? { status: 'pending' } : undefined
		},
		actor
	);
}

// createColumnsBlock (for blockType 'columns') creates each column and its
// one seeded paragraph in the same transaction (record-ops.ts); a bare
// create_record with blockType 'column' against an existing columns block
// similarly seeds one paragraph of its own. Either way, every one of those
// is a real record and needs its own locator entry exactly like
// createRecord's own `id`, or a later write_record/delete_record/
// hold_records call for it would resolve to the wrong (default) shard.
// Recurses generically over whatever depth of children the created record
// actually has (2 levels for a fresh columns block, 1 for a bare column)
// rather than hardcoding either shape. `reserved` is a caller-owned array,
// pushed into as each reservation succeeds — not built up locally and
// returned at the end — so that if a `reserveRecordLocator` call throws
// partway through, everything reserved *before* the throw is still visible
// to the caller's rollback, instead of being lost along with the aborted
// return value. A collision here is as vanishingly unlikely as for `id`
// itself (all fresh nanoids) and isn't specially retried, the same
// accepted-risk tradeoff deleteRecord's locator release already documents
// for the inverse case.
function reserveDescendantLocators(
	doc: Y.Doc,
	record: WorkspaceRecord,
	workspaceId: string,
	defaultSpaceId: string,
	shardId: string,
	reserved: string[]
): void {
	for (const childId of record.childRecordIds ?? []) {
		reserveRecordLocator(workspaceId, defaultSpaceId, childId, shardId);
		reserved.push(childId);
		const child = crdtGetRecord(doc, childId);
		if (child) {
			reserveDescendantLocators(doc, child, workspaceId, defaultSpaceId, shardId, reserved);
		}
	}
}

// Compensating rollback for a columns/column block whose descendant-locator
// reservation failed partway through (see createRecord's catch block
// below): the CRDT tree was already committed by the earlier
// transactWithOrigin call, before any descendant locator was reserved, so a
// failure here must not leave it behind — a half-locator-tracked tree would
// resolve any unreserved id to the wrong (default) shard, and a caller
// retrying after this throw would otherwise create a second, duplicate tree
// alongside the still-committed first one. deleteRecord's own recursion
// (record-ops.ts) already knows how to remove a container and every one of
// its children in one call.
function rollBackContainerCreate(doc: Y.Doc, id: string): void {
	transactWithOrigin(doc, SERVICE_ORIGIN, () => {
		if (crdtGetRecord(doc, id)) crdtDeleteRecord(doc, id);
	});
}

/**
 * Creates a new record (block or row) under `input.parentId`, after checking the caller may
 * access that parent and, for a `page_link`/`child_pages` block whose `referencedRecordId` is
 * set, that its target is itself an accessible Document. Reserves the record's catalog locator
 * before the CRDT write so a row can never exist in a non-default shard without one, rolling
 * the reservation back if the write itself then fails.
 */
export function createRecord(
	caller: CallerIdentity,
	input: CreateRecordServiceInput
): WorkspaceRecord {
	const { doc, workspaceId, shardId, defaultSpaceId } = resolveParentWorkspaceContext(
		input.parentId
	);
	const actor = actorForCaller(caller);

	// A container record (columns/column) isn't itself catalog-navigable —
	// access is checked against its owning Document's grant instead (issue
	// #148). A no-op for every pre-#148 parentId, which was already
	// top-level.
	requireAccessibleParent(caller, resolveOwningParentId(doc, input.parentId), 'create_record');

	validateCreateRecordInput(caller, doc, input);

	// Reserved before the CRDT write (not after) so a row can never exist in a
	// non-default shard without a locator: if reservation itself fails (e.g. a
	// colliding id), nothing has been written yet. If the CRDT write then
	// fails, the reservation is rolled back so no orphaned locator survives it.
	//
	// Reserved regardless of parentKind: Documents have their own shard too
	// (#120), so a Document's own block needs to be locator-tracked exactly
	// like a Collection row — without it, resolveRecordWorkspaceContext's
	// "not found" fallback would route every later write_record/delete_record/
	// hold_records call for this block to the wrong (default) shard.
	const id = nanoid();
	reserveRecordLocator(workspaceId, defaultSpaceId, id, shardId);

	// Both container-creating blockTypes seed at least one descendant that
	// needs its own locator: 'columns' seeds N columns (each with its own
	// paragraph), and a bare 'column' (an agent adding one to an existing
	// columns block) seeds one paragraph of its own — see
	// reserveDescendantLocators.
	const isContainerCreate = input.blockType === 'columns' || input.blockType === 'column';
	let record: WorkspaceRecord;
	const reservedChildIds: string[] = [];
	try {
		record = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			performCreateRecord(doc, id, input, actor)
		);
		if (isContainerCreate) {
			reserveDescendantLocators(
				doc,
				record,
				workspaceId,
				defaultSpaceId,
				shardId,
				reservedChildIds
			);
		}
	} catch (err) {
		releaseRecordLocator(workspaceId, id);
		for (const childId of reservedChildIds) releaseRecordLocator(workspaceId, childId);
		if (isContainerCreate) rollBackContainerCreate(doc, id);
		throw err;
	}

	logAudit({ actor, action: 'create_record', targetRecordId: record.id });
	return record;
}

/**
 * Fetches (or re-fetches) a bookmark block's preview metadata and writes the
 * result — the one async, I/O-performing service function in this module
 * (issue #155). Kept separate from `createRecord`/`writeRecord` (both stay
 * synchronous) rather than making either of those async: `createRecord` has
 * dozens of synchronous call sites across the UI/test suite, and doing an
 * uncontrolled outbound fetch inside a Yjs transaction is unsafe regardless
 * (transactions must stay synchronous). The MCP create_record tool handler
 * (server.ts) awaits this immediately after a bookmark-with-url create, so an
 * agent gets a fully-previewed bookmark in one round trip; the UI's
 * equivalent is BookmarkBlock.svelte calling the bookmark-preview API route
 * (src/routes/api/records/[id]/bookmark-preview), which calls this same
 * function server-side.
 *
 * `documentId`, when supplied, resolves the record's shard via its owning
 * Document's own (always locator-tracked, `reserveDocumentLocator`) id
 * instead of the record's own bare id — required for a bookmark created as a
 * *direct UI mutation* (BookmarkBlock.svelte's own client-side
 * `crdtCreateRecord`/`setBlockType`, bypassing this service layer entirely —
 * see audit-coverage.md §1), which never gets its own locator the way an
 * MCP-created one does (this module's own `createRecord`, via
 * `reserveRecordLocator`). Without the hint, `resolveRecordWorkspaceContext`'s
 * "not found" fallback resolves to the wrong (default) shard once Documents
 * are individually sharded (#120), and the call 404s even though the record
 * genuinely exists — see `requireAccessibleRecordInDoc`'s own doc comment
 * (services/permissions.ts). The MCP `refresh_bookmark_metadata` tool omits
 * it: an agent-created bookmark already has its own locator, so the default
 * bare-id resolution already finds the right shard.
 *
 * Never throws for a fetch/parse failure — that degrades to an error status
 * instead, per the PRD's "always retains an accessible plain link as a
 * fallback" requirement (the block's own url is untouched either way). Only a
 * permission failure or a call against a non-bookmark/url-less block throws,
 * before any fetch is attempted.
 */
export async function refreshBookmarkMetadata(
	caller: CallerIdentity,
	recordId: string,
	documentId?: string
): Promise<WorkspaceRecord> {
	const { doc } = documentId
		? resolveParentWorkspaceContext(documentId)
		: resolveRecordWorkspaceContext(recordId);
	const actor = actorForCaller(caller);
	const record = requireAccessibleRecordInDoc(doc, caller, recordId, 'write_record');

	if (record.blockType !== 'bookmark') {
		throw new Error('refreshBookmarkMetadata can only be called on a bookmark block.');
	}
	if (!record.url) {
		throw new Error('This bookmark block has no url set yet.');
	}

	let metadata: BookmarkMetadata;
	try {
		const fetched = await fetchLinkPreviewMetadata(record.url);
		metadata = { status: 'ready', fetchedAt: Date.now(), ...fetched };
	} catch {
		metadata = { status: 'error', fetchedAt: Date.now() };
	}

	const before = record.bookmarkMetadata;
	transactWithOrigin(doc, SERVICE_ORIGIN, () => {
		crdtSetRecordBookmarkMetadata(doc, recordId, metadata, actor);
	});
	logAudit({
		actor,
		action: 'write_record',
		targetRecordId: recordId,
		diff: { bookmarkMetadata: { before, after: metadata } }
	});
	return crdtGetRecord(doc, recordId)!;
}

interface WriteRecordInput {
	markdown?: string;
	properties?: Record<string, PropertyValue>;
	referencedRecordId?: string;
	viewConfig?: EmbeddedViewConfig;
	viewConfigPatch?: Partial<ViewConfig>;
}

// Validated up front, before any mutation in writeRecord below: a call
// combining markdown (or properties) with an invalid referencedRecordId
// must reject cleanly, not commit the content write, release the hold, and
// audit it before throwing on the retarget. write_record's referencedRecordId
// support covers page_link and collection_view (the two block types whose
// target is retargetable post-creation) — unlike create_record's initial
// value, reconfiguring a child_pages block's target after creation is
// UI-only, via setRecordChildPagesConfig, the same "no MCP write path"
// precedent calloutStyle already established (rich-text-toolbar.md §7).
function validateReferencedRecordIdWrite(
	caller: CallerIdentity,
	doc: Y.Doc,
	record: WorkspaceRecord,
	referencedRecordId: string
): void {
	if (record.blockType === 'page_link') {
		requireParentDocumentThenValidateTarget(
			caller,
			doc,
			record.parentId,
			referencedRecordId,
			'document',
			'page_link blocks can only exist inside a Document.'
		);
		return;
	}
	if (record.blockType === 'collection_view') {
		requireParentDocumentThenValidateTarget(
			caller,
			doc,
			record.parentId,
			referencedRecordId,
			'collection',
			'collection_view blocks can only exist inside a Document.'
		);
		return;
	}
	throw new Error(
		'referencedRecordId can only be written on a page_link or collection_view block.'
	);
}

function writeRecordMarkdown(
	caller: CallerIdentity,
	doc: Y.Doc,
	awareness: Awareness,
	recordId: string,
	actor: ReturnType<typeof actorForCaller>,
	markdown: string
): void {
	// An agent (access-token caller) must hold the record first — same
	// concurrent-edit protection a human's cursor gives implicitly (see
	// collaboration.md). A human-attributed write (the personal-AI-client
	// path, still `human-via-client`) has no separate hold step to check.
	const clientId = isAccessToken(caller) ? clientIdForToken(caller.tokenHash) : undefined;
	if (clientId !== undefined && !isHeldByClient(awareness, clientId, recordId)) {
		throw new HoldRequiredError(
			`No active hold on ${recordId} — call hold_records first, then retry (the hold may have been released by a concurrent human edit).`
		);
	}

	const richText = markdownToRichText(doc, markdown);
	const ytext = getRecordYText(doc, recordId);
	const before = ytext ? yTextToRichText(ytext) : undefined;
	updateRecordContent(doc, recordId, richText, actor);
	if (clientId !== undefined) {
		releaseAgentHold(awareness, clientId, [recordId]);
	}

	logAudit({
		actor,
		action: 'write_record',
		targetRecordId: recordId,
		diff: { before, after: richText }
	});
}

function applyReferencedRecordIdWrite(
	doc: Y.Doc,
	record: WorkspaceRecord,
	recordId: string,
	actor: ReturnType<typeof actorForCaller>,
	referencedRecordId: string
): void {
	// A retarget is a metadata write, not a content write — there's no Y.Text
	// for a human cursor to be inside, so unlike the markdown branch above
	// this needs no hold (same exemption already applied to `properties`,
	// which is also metadata-only; see docs/specifications/mcp-tools.md).
	// Idempotent by construction: writing the same target twice is a no-op
	// Y.Map.set, not a distinct state transition.
	const before = record.referencedRecordId;
	crdtSetRecordReferencedId(doc, recordId, referencedRecordId, actor);
	logAudit({
		actor,
		action: 'write_record',
		targetRecordId: recordId,
		diff: { referencedRecordId: { before, after: referencedRecordId } }
	});
}

function applyViewConfigWrite(
	doc: Y.Doc,
	record: WorkspaceRecord,
	recordId: string,
	actor: ReturnType<typeof actorForCaller>,
	viewConfig: EmbeddedViewConfig
): void {
	// A full replace, mirroring create_record's initial value — for an agent
	// caller that means "outright reconfigure" (same shape setRecordViewConfig
	// is for; see its own doc comment). A caller that only wants to change a
	// subset of members without clobbering the rest should use
	// viewConfigPatch (applyViewConfigPatchWrite below, issue #195) instead.
	const before = record.viewConfig;
	crdtSetRecordViewConfig(doc, recordId, viewConfig, actor);
	logAudit({
		actor,
		action: 'write_record',
		targetRecordId: recordId,
		diff: { viewConfig: { before, after: viewConfig } }
	});
}

/**
 * Merges a partial set of viewConfig member changes into an existing collection_view block —
 * the MCP-facing counterpart to the UI's per-member `patchRecordViewConfig` (issue #71), added
 * so an agent that only means to change e.g. `filters` doesn't have to round-trip and resupply
 * every other member via a whole-value `viewConfig` write, silently clobbering whatever another
 * actor concurrently set on a member it never touched (issue #195). Audited as the incoming
 * patch itself (cleared members re-encoded as JSON `null`, see below), the same "log what was
 * supplied" convention `properties`' merge-write uses below — not a before/after pair, since a
 * member absent from the patch was deliberately left alone.
 */
function applyViewConfigPatchWrite(
	doc: Y.Doc,
	recordId: string,
	actor: ReturnType<typeof actorForCaller>,
	viewConfigPatch: Partial<ViewConfig>
): void {
	crdtPatchRecordViewConfig(doc, recordId, viewConfigPatch, actor);
	// The audit_log's diff column round-trips through JSON.stringify (Drizzle's
	// `mode: 'json'`, see src/lib/server/db/schema.ts), which drops any
	// property whose value is `undefined` entirely — so a cleared member
	// (present in viewConfigPatch as an explicit `undefined`, per
	// patchRecordViewConfig's own contract) would otherwise vanish from the
	// persisted diff instead of recording that it was cleared. Map it to
	// `null` here, for the audit record only — crdtPatchRecordViewConfig above
	// already received the real `undefined`-keyed patch it needs.
	const auditablePatch: Record<string, unknown> = {};
	for (const key of Object.keys(viewConfigPatch) as (keyof ViewConfig)[]) {
		auditablePatch[key] = viewConfigPatch[key] ?? null;
	}
	logAudit({
		actor,
		action: 'write_record',
		targetRecordId: recordId,
		diff: { viewConfigPatch: auditablePatch }
	});
}

/**
 * Applies one or more of `input.markdown`/`properties`/`referencedRecordId`/`viewConfig`/
 * `viewConfigPatch` to a record, after checking the caller may access it. Each part is
 * validated up front — an invalid `referencedRecordId`/`viewConfig`/`viewConfigPatch` rejects
 * before any mutation, content write, or hold release commits — and each applied part is
 * audited separately. A markdown write additionally requires an agent caller to already hold
 * the record (see writeRecordMarkdown), releasing that hold on success. `viewConfig` and
 * `viewConfigPatch` are mutually exclusive (whole-replace vs. per-member merge — see
 * applyViewConfigWrite/applyViewConfigPatchWrite) rather than one silently overriding the other.
 */
export function writeRecord(
	caller: CallerIdentity,
	recordId: string,
	input: WriteRecordInput
): void {
	if (
		input.markdown === undefined &&
		!input.properties &&
		input.referencedRecordId === undefined &&
		input.viewConfig === undefined &&
		input.viewConfigPatch === undefined
	) {
		throw new Error(
			'write_record requires markdown, properties, referencedRecordId, viewConfig, or viewConfigPatch'
		);
	}

	if (input.viewConfig !== undefined && input.viewConfigPatch !== undefined) {
		throw new Error('write_record accepts either viewConfig or viewConfigPatch, not both.');
	}

	const { doc, awareness } = resolveRecordWorkspaceContext(recordId);
	const actor = actorForCaller(caller);
	const record = requireAccessibleRecord(caller, recordId, 'write_record');

	// A columns/column block has no content of its own (data-model.md §3.1) —
	// its markdown is entirely derived from its columns' children
	// (document-projection.ts's renderColumnsMarkdown), so a markdown write
	// here would have nowhere to go: no UI ever renders it, and it wouldn't
	// even round-trip through get_document, unlike every other structural
	// block type's content.
	if (
		input.markdown !== undefined &&
		(record.blockType === 'columns' || record.blockType === 'column')
	) {
		throw new Error(
			'markdown cannot be written to a columns or column block directly — write to one of its nested blocks instead.'
		);
	}

	// A bookmark block's own content Y.Text is allocated like any other leaf
	// block's (createRecord doesn't special-case it away, unlike columns/
	// column) but is never rendered anywhere — its real data is url/
	// bookmarkMetadata (issue #155), and renderBookmarkMarkdown
	// (document-projection.ts) never reads content. A markdown write here
	// would silently vanish from both the UI and get_document, the same
	// "nowhere to go" reasoning as the columns/column guard above.
	if (input.markdown !== undefined && record.blockType === 'bookmark') {
		throw new Error(
			'markdown cannot be written to a bookmark block — set its url via create_record, or refresh its preview via refresh_bookmark_metadata.'
		);
	}

	if (input.referencedRecordId !== undefined) {
		validateReferencedRecordIdWrite(caller, doc, record, input.referencedRecordId);
	}

	if (input.viewConfig !== undefined) {
		validateViewConfig(record.blockType, input.viewConfig);
	}

	if (input.viewConfigPatch !== undefined) {
		validateViewConfigPatch(record.blockType, record.viewConfig);
	}

	transactWithOrigin(doc, SERVICE_ORIGIN, () => {
		if (input.markdown !== undefined) {
			writeRecordMarkdown(caller, doc, awareness, recordId, actor, input.markdown);
		}
		if (input.properties) {
			updateRecordProperties(doc, recordId, input.properties, actor);
			logAudit({
				actor,
				action: 'write_record',
				targetRecordId: recordId,
				diff: { properties: input.properties }
			});
		}
		if (input.referencedRecordId !== undefined) {
			applyReferencedRecordIdWrite(doc, record, recordId, actor, input.referencedRecordId);
		}
		if (input.viewConfig !== undefined) {
			applyViewConfigWrite(doc, record, recordId, actor, input.viewConfig);
		}
		if (input.viewConfigPatch !== undefined) {
			applyViewConfigPatchWrite(doc, recordId, actor, input.viewConfigPatch);
		}
	});
}

/**
 * Deletes a record (after a permission check) and releases its catalog locator. A locator
 * release failure is logged, not thrown — the CRDT delete has already committed by that
 * point, so failing the call back to the caller would misreport a completed deletion as an
 * error; a stale locator row for a since-deleted record fails safe either way.
 */
export function deleteRecord(caller: CallerIdentity, recordId: string): void {
	const { doc, workspaceId } = resolveRecordWorkspaceContext(recordId);
	const actor = actorForCaller(caller);

	requireAccessibleRecord(caller, recordId, 'delete_record');
	transactWithOrigin(doc, SERVICE_ORIGIN, () => crdtDeleteRecord(doc, recordId));
	// The CRDT delete has already committed at this point — a release failure
	// here must not throw back to the caller as if deletion itself failed. Log
	// it instead: a stale locator row for a since-deleted record fails safe
	// (getRecord on it 404s from the CRDT side either way), whereas throwing
	// would misreport a completed deletion as an error.
	try {
		releaseRecordLocator(workspaceId, recordId);
	} catch (err) {
		console.error(`[records] failed to release locator for deleted record ${recordId}`, err);
	}
	logAudit({ actor, action: 'delete_record', targetRecordId: recordId });
}

/** Returns a single record after checking the caller may access it. */
export function getRecord(caller: CallerIdentity, recordId: string): WorkspaceRecord | undefined {
	return requireAccessibleRecord(caller, recordId, 'get_record');
}
