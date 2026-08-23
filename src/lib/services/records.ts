import { getYDoc } from '$lib/server/ydoc';
import { getAwareness } from '$lib/server/awareness';
import { clientIdForToken, isHeldByClient, releaseAgentHold } from '$lib/server/holds';
import {
	createRecord as crdtCreateRecord,
	deleteRecord as crdtDeleteRecord,
	getRecordYText,
	updateRecordContent,
	updateRecordProperties
} from '$lib/data/records';
import { logAudit } from '$lib/server/audit';
import { markdownToRichText } from '$lib/mcp/markdown-transcode';
import { yTextToRichText } from '$lib/data/richtext';
import type { BlockType, PropertyValue, WorkspaceRecord } from '$lib/data/types';
import {
	actorForCaller,
	isAccessToken,
	requireAccessibleParent,
	requireAccessibleRecord,
	type CallerIdentity
} from './permissions';

export class HoldRequiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'HoldRequiredError';
	}
}

export function createRecord(
	caller: CallerIdentity,
	input: {
		parentId: string;
		afterRecordId?: string;
		blockType?: BlockType;
		properties?: Record<string, PropertyValue>;
	}
): WorkspaceRecord {
	const doc = getYDoc();
	const actor = actorForCaller(caller);

	requireAccessibleParent(caller, input.parentId);
	const record = crdtCreateRecord(
		doc,
		{
			parentId: input.parentId,
			afterRecordId: input.afterRecordId,
			blockType: input.blockType,
			properties: input.properties
		},
		actor
	);

	logAudit({ actor, action: 'create_record', targetRecordId: record.id });
	return record;
}

export function writeRecord(
	caller: CallerIdentity,
	recordId: string,
	input: {
		markdown?: string;
		properties?: Record<string, PropertyValue>;
	}
): void {
	if (input.markdown === undefined && !input.properties) {
		throw new Error('write_record requires markdown or properties');
	}

	const doc = getYDoc();
	const actor = actorForCaller(caller);
	requireAccessibleRecord(caller, recordId);

	if (input.markdown !== undefined) {
		if (isAccessToken(caller)) {
			const awareness = getAwareness();
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
}

export function deleteRecord(caller: CallerIdentity, recordId: string): void {
	const doc = getYDoc();
	const actor = actorForCaller(caller);

	requireAccessibleRecord(caller, recordId);
	crdtDeleteRecord(doc, recordId);
	logAudit({ actor, action: 'delete_record', targetRecordId: recordId });
}

export function getRecord(caller: CallerIdentity, recordId: string): WorkspaceRecord | undefined {
	return requireAccessibleRecord(caller, recordId);
}
