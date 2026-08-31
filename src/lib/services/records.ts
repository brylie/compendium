import { nanoid } from 'nanoid';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
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
import type { BlockType, PropertyValue, WorkspaceRecord } from '$lib/data/types';
import {
	actorForCaller,
	isAccessToken,
	requireAccessibleParent,
	requireAccessibleRecord,
	resolveParentWorkspaceContext,
	resolveRecordWorkspaceContext,
	type CallerIdentity
} from './permissions';

export class HoldRequiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HoldRequiredError';
	}
}

// A page_link's target must be a Document the caller can already reach —
// deliberately a single generic message for "doesn't exist" and "exists but
// out of token scope" alike, so a probing caller can't use this as an oracle
// to learn whether a given ID exists (docs/specifications/internal-links.md §4,
// audit-coverage.md §3's "never leak more than what the caller already
// supplied" principle).
export class InvalidLinkTargetError extends Error {
	constructor(targetId: string) {
		super(`${targetId} is not an accessible Document — page_link can only target one.`);
		this.name = 'InvalidLinkTargetError';
	}
}

function validatePageLinkTarget(caller: CallerIdentity, targetId: string): void {
	const { doc } = resolveWorkspaceContext();
	const target = crdtGetDocument(doc, targetId);
	if (!target) throw new InvalidLinkTargetError(targetId);
	if (isAccessToken(caller) && !tokenAllowsParent(caller, targetId)) {
		throw new InvalidLinkTargetError(targetId);
	}
}

export function createRecord(
	caller: CallerIdentity,
	input: {
		parentId: string;
		afterRecordId?: string;
		blockType?: BlockType;
		properties?: Record<string, PropertyValue>;
		referencedRecordId?: string;
	}
): WorkspaceRecord {
	const { doc, workspaceId, shardId, defaultSpaceId, parentKind } = resolveParentWorkspaceContext(
		input.parentId
	);
	const actor = actorForCaller(caller);

	requireAccessibleParent(caller, input.parentId, 'create_record');

	if (input.referencedRecordId !== undefined) {
		if (input.blockType !== 'page_link') {
			throw new Error('referencedRecordId is only valid on a page_link block.');
		}
		if (!crdtGetDocument(doc, input.parentId)) {
			throw new Error('page_link blocks can only be created inside a Document.');
		}
		validatePageLinkTarget(caller, input.referencedRecordId);
	}

	// Reserved before the CRDT write (not after) so a row can never exist in a
	// non-default shard without a locator: if reservation itself fails (e.g. a
	// colliding id), nothing has been written yet. If the CRDT write then
	// fails, the reservation is rolled back so no orphaned locator survives it.
	//
	// Document blocks stay untracked — they're always in the default shard as
	// long as Documents themselves aren't sharded, so resolveRecordWorkspaceContext's
	// "not found" fallback already routes them correctly without a locator row.
	const id = nanoid();
	if (parentKind === 'collection') {
		reserveRecordLocator(workspaceId, defaultSpaceId, id, shardId);
	}

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
				referencedRecordId: input.referencedRecordId
			},
			actor
		);
	} catch (err) {
		if (parentKind === 'collection') releaseRecordLocator(workspaceId, id);
		throw err;
	}

	logAudit({ actor, action: 'create_record', targetRecordId: record.id });
	return record;
}

export function writeRecord(
	caller: CallerIdentity,
	recordId: string,
	input: {
		markdown?: string;
		properties?: Record<string, PropertyValue>;
		referencedRecordId?: string;
	}
): void {
	if (input.markdown === undefined && !input.properties && input.referencedRecordId === undefined) {
		throw new Error('write_record requires markdown, properties, or referencedRecordId');
	}

	const { doc, awareness } = resolveRecordWorkspaceContext(recordId);
	const actor = actorForCaller(caller);
	const record = requireAccessibleRecord(caller, recordId, 'write_record');

	// Validated up front, before any mutation below: a call combining markdown
	// (or properties) with an invalid referencedRecordId must reject cleanly,
	// not commit the content write, release the hold, and audit it before
	// throwing on the retarget.
	if (input.referencedRecordId !== undefined) {
		if (record.blockType !== 'page_link') {
			throw new Error('referencedRecordId can only be written on a page_link block.');
		}
		if (!crdtGetDocument(doc, record.parentId)) {
			throw new Error('page_link blocks can only exist inside a Document.');
		}
		validatePageLinkTarget(caller, input.referencedRecordId);
	}

	if (input.markdown !== undefined) {
		if (isAccessToken(caller)) {
			const clientId = clientIdForToken(caller.tokenHash);
			if (!isHeldByClient(awareness, clientId, recordId)) {
				throw new HoldRequiredError(
					`No active hold on ${recordId} — call hold_records first, then retry (the hold may have been released by a concurrent human edit).`
				);
			}
			const richText = markdownToRichText(doc, input.markdown);
			const ytext = getRecordYText(doc, recordId);
			const before = ytext ? yTextToRichText(ytext) : undefined;

			updateRecordContent(doc, recordId, richText, actor);
			releaseAgentHold(awareness, clientId, [recordId]);

			logAudit({
				actor,
				action: 'write_record',
				targetRecordId: recordId,
				diff: { before, after: richText }
			});
		} else {
			const richText = markdownToRichText(doc, input.markdown);
			const ytext = getRecordYText(doc, recordId);
			const before = ytext ? yTextToRichText(ytext) : undefined;

			updateRecordContent(doc, recordId, richText, actor);
			logAudit({
				actor,
				action: 'write_record',
				targetRecordId: recordId,
				diff: { before, after: richText }
			});
		}
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
		// A retarget is a metadata write, not a content write — there's no Y.Text
		// for a human cursor to be inside, so unlike the markdown branch above
		// this needs no hold (same exemption already applied to `properties`,
		// which is also metadata-only; see docs/specifications/mcp-tools.md).
		// Idempotent by construction: writing the same target twice is a no-op
		// Y.Map.set, not a distinct state transition.
		const before = record.referencedRecordId;
		crdtSetRecordReferencedId(doc, recordId, input.referencedRecordId, actor);
		logAudit({
			actor,
			action: 'write_record',
			targetRecordId: recordId,
			diff: { referencedRecordId: { before, after: input.referencedRecordId } }
		});
	}
}

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

export function getRecord(caller: CallerIdentity, recordId: string): WorkspaceRecord | undefined {
	return requireAccessibleRecord(caller, recordId, 'get_record');
}
