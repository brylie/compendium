import { nanoid } from 'nanoid';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { clientIdForToken, isHeldByClient, releaseAgentHold } from '$lib/server/holds';
import {
	createRecord as crdtCreateRecord,
	deleteRecord as crdtDeleteRecord,
	getCollection as crdtGetCollection,
	getDocument as crdtGetDocument,
	getRecordYText,
	setRecordReferencedId as crdtSetRecordReferencedId,
	setRecordViewConfig as crdtSetRecordViewConfig,
	updateRecordContent,
	updateRecordProperties
} from '$lib/data/records';
import { logAudit } from '$lib/server/audit';
import { reserveRecordLocator, releaseRecordLocator } from '$lib/server/catalog';
import { markdownToRichText } from '$lib/mcp/markdown-transcode';
import { yTextToRichText } from '$lib/data/richtext';
import { tokenAllowsParent } from '$lib/mcp/tokens';
import type {
	BlockType,
	ChildPagesDepth,
	EmbeddedViewConfig,
	PropertyValue,
	ViewType,
	WorkspaceRecord
} from '$lib/data/types';
import {
	actorForCaller,
	isAccessToken,
	requireAccessibleParent,
	requireAccessibleRecord,
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

function validateDocumentReferenceTarget(caller: CallerIdentity, targetId: string): void {
	// The target is always a Document, which has its own real shard (#120) —
	// resolveParentWorkspaceContext finds it via the catalog locator, falling
	// back to the default doc for an untracked/legacy target.
	const { doc, parentSpaceId } = resolveParentWorkspaceContext(targetId);
	const target = crdtGetDocument(doc, targetId);
	if (!target) throw new InvalidLinkTargetError(targetId);
	if (isAccessToken(caller) && !tokenAllowsParent(caller, targetId, parentSpaceId)) {
		throw new InvalidLinkTargetError(targetId);
	}
}

// A collection_view block's referencedRecordId must resolve to an existing,
// caller-accessible Collection (never a Document) — mirrors the
// `linkedTarget?.kind === 'collection'` check the read side already applies
// (services/documents.ts's resolveRecordLink), closing the write-side gap
// tracked by issue #37.
function validateCollectionReferenceTarget(caller: CallerIdentity, targetId: string): void {
	// A Collection has its own real shard too (#120) — same locator-backed
	// resolution validateDocumentReferenceTarget uses above.
	const { doc, parentSpaceId } = resolveParentWorkspaceContext(targetId);
	const target = crdtGetCollection(doc, targetId);
	if (!target) throw new InvalidLinkTargetError(targetId, 'Collection');
	if (isAccessToken(caller) && !tokenAllowsParent(caller, targetId, parentSpaceId)) {
		throw new InvalidLinkTargetError(targetId, 'Collection');
	}
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
		if (!crdtGetDocument(doc, parentId)) {
			throw new Error('page_link and child_pages blocks can only be created inside a Document.');
		}
		validateDocumentReferenceTarget(caller, referencedRecordId);
		return;
	}
	if (blockType === 'collection_view') {
		if (!crdtGetDocument(doc, parentId)) {
			throw new Error('collection_view blocks can only be created inside a Document.');
		}
		validateCollectionReferenceTarget(caller, referencedRecordId);
		return;
	}
	throw new Error(
		'referencedRecordId is only valid on a page_link, child_pages, or collection_view block.'
	);
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
	input: {
		parentId: string;
		afterRecordId?: string;
		blockType?: BlockType;
		properties?: Record<string, PropertyValue>;
		referencedRecordId?: string;
		viewConfig?: EmbeddedViewConfig;
		childPagesDepth?: ChildPagesDepth;
	}
): WorkspaceRecord {
	const { doc, workspaceId, shardId, defaultSpaceId } = resolveParentWorkspaceContext(
		input.parentId
	);
	const actor = actorForCaller(caller);

	requireAccessibleParent(caller, input.parentId, 'create_record');

	// Checked unconditionally, not just when referencedRecordId/childPagesDepth
	// happen to be supplied — a targetless, default-depth child_pages block
	// ("list the current Document's own children") is the single most common
	// call shape, and without this the CRDT layer would otherwise silently
	// treat a Collection parent as a plain row, ignoring blockType entirely.
	if (input.blockType === 'child_pages' && !crdtGetDocument(doc, input.parentId)) {
		throw new Error('child_pages blocks can only be created inside a Document.');
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

	let record: WorkspaceRecord;
	try {
		record = crdtCreateRecord(
			doc,
			{
				id,
				parentId: input.parentId,
				afterRecordId: input.afterRecordId,
				blockType: input.blockType,
				properties: input.properties,
				referencedRecordId: input.referencedRecordId,
				viewConfig: input.viewConfig,
				childPagesDepth: input.childPagesDepth
			},
			actor
		);
	} catch (err) {
		releaseRecordLocator(workspaceId, id);
		throw err;
	}

	logAudit({ actor, action: 'create_record', targetRecordId: record.id });
	return record;
}

interface WriteRecordInput {
	markdown?: string;
	properties?: Record<string, PropertyValue>;
	referencedRecordId?: string;
	viewConfig?: EmbeddedViewConfig;
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
		if (!crdtGetDocument(doc, record.parentId)) {
			throw new Error('page_link blocks can only exist inside a Document.');
		}
		validateDocumentReferenceTarget(caller, referencedRecordId);
		return;
	}
	if (record.blockType === 'collection_view') {
		if (!crdtGetDocument(doc, record.parentId)) {
			throw new Error('collection_view blocks can only exist inside a Document.');
		}
		validateCollectionReferenceTarget(caller, referencedRecordId);
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
	// A full replace, mirroring create_record's initial value — not the UI's
	// per-member patchRecordViewConfig (issue #71), which exists to let two
	// draft-editing collaborators' concurrent member edits both survive. An
	// MCP write always supplies a whole EmbeddedViewConfig, the same "outright
	// reconfigure" shape setRecordViewConfig is for (see its own doc comment).
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
 * Applies one or more of `input.markdown`/`properties`/`referencedRecordId`/`viewConfig` to a
 * record, after checking the caller may access it. Each part is validated up front — an
 * invalid `referencedRecordId`/`viewConfig` rejects before any mutation, content write, or
 * hold release commits — and each applied part is audited separately. A markdown write
 * additionally requires an agent caller to already hold the record (see writeRecordMarkdown),
 * releasing that hold on success.
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
		input.viewConfig === undefined
	) {
		throw new Error(
			'write_record requires markdown, properties, referencedRecordId, or viewConfig'
		);
	}

	const { doc, awareness } = resolveRecordWorkspaceContext(recordId);
	const actor = actorForCaller(caller);
	const record = requireAccessibleRecord(caller, recordId, 'write_record');

	if (input.referencedRecordId !== undefined) {
		validateReferencedRecordIdWrite(caller, doc, record, input.referencedRecordId);
	}

	if (input.viewConfig !== undefined) {
		validateViewConfig(record.blockType, input.viewConfig);
	}

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
	crdtDeleteRecord(doc, recordId);
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
