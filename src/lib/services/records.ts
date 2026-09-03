import { nanoid } from 'nanoid';
import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { clientIdForToken, isHeldByClient, releaseAgentHold } from '$lib/server/holds';
import {
	createRecord as crdtCreateRecord,
	deleteRecord as crdtDeleteRecord,
	getDocument as crdtGetDocument,
	getRecordYText,
	setRecordReferencedId as crdtSetRecordReferencedId,
	updateRecordContent,
	updateRecordProperties
} from '$lib/data/records';
import { logAudit } from '$lib/server/audit';
import { reserveRecordLocator, releaseRecordLocator } from '$lib/server/catalog';
import { markdownToRichText } from '$lib/mcp/markdown-transcode';
import { yTextToRichText } from '$lib/data/richtext';
import { tokenAllowsParent } from '$lib/mcp/tokens';
import type { BlockType, ChildPagesDepth, PropertyValue, WorkspaceRecord } from '$lib/data/types';
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
 * Thrown when a `page_link`/`child_pages` block's target isn't a Document the caller can
 * already reach. Deliberately a single generic message for "doesn't exist" and "exists but out
 * of token scope" alike, so a probing caller can't use this as an oracle to learn whether a
 * given ID exists (docs/specifications/internal-links.md §4, audit-coverage.md §3's "never leak
 * more than what the caller already supplied" principle).
 */
export class InvalidLinkTargetError extends Error {
	constructor(targetId: string) {
		super(`${targetId} is not an accessible Document — page_link/child_pages can only target one.`);
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

function validateChildPagesDepth(depth: ChildPagesDepth): void {
	if (depth === 'unlimited') return;
	if (!Number.isSafeInteger(depth) || depth < 1) {
		throw new Error('childPagesDepth must be a positive integer or "unlimited".');
	}
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
		if (!input.blockType || !DOCUMENT_REFERENCE_BLOCK_TYPES.includes(input.blockType)) {
			throw new Error('referencedRecordId is only valid on a page_link or child_pages block.');
		}
		if (!crdtGetDocument(doc, input.parentId)) {
			throw new Error('page_link and child_pages blocks can only be created inside a Document.');
		}
		validateDocumentReferenceTarget(caller, input.referencedRecordId);
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
}

// Validated up front, before any mutation in writeRecord below: a call
// combining markdown (or properties) with an invalid referencedRecordId
// must reject cleanly, not commit the content write, release the hold, and
// audit it before throwing on the retarget. write_record's referencedRecordId
// support stays page_link-only — unlike create_record's initial value,
// reconfiguring a child_pages block's target after creation is UI-only, via
// setRecordChildPagesConfig, the same "no MCP write path" precedent
// calloutStyle already established (rich-text-toolbar.md §7).
function validateReferencedRecordIdWrite(
	caller: CallerIdentity,
	doc: Y.Doc,
	record: WorkspaceRecord,
	referencedRecordId: string
): void {
	if (record.blockType !== 'page_link') {
		throw new Error('referencedRecordId can only be written on a page_link block.');
	}
	if (!crdtGetDocument(doc, record.parentId)) {
		throw new Error('page_link blocks can only exist inside a Document.');
	}
	validateDocumentReferenceTarget(caller, referencedRecordId);
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

/**
 * Applies one or more of `input.markdown`/`properties`/`referencedRecordId` to a record,
 * after checking the caller may access it. Each part is validated up front — an invalid
 * `referencedRecordId` rejects before any mutation, content write, or hold release commits —
 * and each applied part is audited separately. A markdown write additionally requires an
 * agent caller to already hold the record (see writeRecordMarkdown), releasing that hold on
 * success.
 */
export function writeRecord(
	caller: CallerIdentity,
	recordId: string,
	input: WriteRecordInput
): void {
	if (input.markdown === undefined && !input.properties && input.referencedRecordId === undefined) {
		throw new Error('write_record requires markdown, properties, or referencedRecordId');
	}

	const { doc, awareness } = resolveRecordWorkspaceContext(recordId);
	const actor = actorForCaller(caller);
	const record = requireAccessibleRecord(caller, recordId, 'write_record');

	if (input.referencedRecordId !== undefined) {
		validateReferencedRecordIdWrite(caller, doc, record, input.referencedRecordId);
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
