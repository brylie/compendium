import { getYDoc } from '$lib/server/ydoc';
import {
	createDocument as crdtCreateDocument,
	createRecord as crdtCreateRecord,
	deleteDocument as crdtDeleteDocument,
	getDocument as crdtGetDocument,
	listDocuments as crdtListDocuments,
	listRecordsForParent as crdtListRecordsForParent,
	updateDocumentParent as crdtUpdateDocumentParent,
	updateDocumentTitle as crdtUpdateDocumentTitle
} from '$lib/data/records';
import { logAudit } from '$lib/server/audit';
import { grantDocumentAccess, tokenAllowsParent } from '$lib/mcp/tokens';
import { richTextToMarkdown } from '$lib/mcp/markdown-transcode';
import type { DocumentMeta } from '$lib/data/types';
import {
	actorForCaller,
	isAccessToken,
	requireAccessibleParent,
	type CallerIdentity
} from './permissions';

export interface CreateDocumentInput {
	id?: string;
	title: string;
	parentDocumentId?: string;
	afterDocumentId?: string;
	createInitialBlock?: boolean;
}

export function createDocument(caller: CallerIdentity, input: CreateDocumentInput): DocumentMeta {
	const doc = getYDoc();
	const actor = actorForCaller(caller);

	// Decision: In single-tenant Phase 0/1, any authenticated caller is permitted
	// to create top-level documents; when nested, access to parentDocumentId is verified.
	if (input.parentDocumentId) {
		requireAccessibleParent(caller, input.parentDocumentId);
	}

	const document = crdtCreateDocument(doc, {
		id: input.id,
		title: input.title,
		parentDocumentId: input.parentDocumentId,
		afterDocumentId: input.afterDocumentId
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

export function moveDocument(
	caller: CallerIdentity,
	documentId: string,
	options: { parentDocumentId?: string; afterDocumentId?: string }
): void {
	const doc = getYDoc();
	const actor = actorForCaller(caller);

	requireAccessibleParent(caller, documentId);
	if (options.parentDocumentId) {
		requireAccessibleParent(caller, options.parentDocumentId);
	}

	crdtUpdateDocumentParent(doc, documentId, options.parentDocumentId, options.afterDocumentId);
	logAudit({
		actor,
		action: 'move_document',
		targetRecordId: documentId,
		diff: options
	});
}

export function deleteDocument(caller: CallerIdentity, documentId: string): void {
	const doc = getYDoc();
	const actor = actorForCaller(caller);

	requireAccessibleParent(caller, documentId);
	crdtDeleteDocument(doc, documentId);
	logAudit({ actor, action: 'delete_document', targetRecordId: documentId });
}

export function updateDocumentTitle(
	caller: CallerIdentity,
	documentId: string,
	title: string
): void {
	const doc = getYDoc();
	const actor = actorForCaller(caller);

	requireAccessibleParent(caller, documentId);
	crdtUpdateDocumentTitle(doc, documentId, title);
	logAudit({
		actor,
		action: 'update_document_title',
		targetRecordId: documentId,
		diff: { title }
	});
}

export function getDocument(
	caller: CallerIdentity,
	documentId: string
): {
	id: string;
	title: string;
	parentDocumentId?: string;
	records: Array<{
		id: string;
		blockType?: string;
		checked?: boolean;
		collapsed?: boolean;
		referencedRecordId?: string;
		markdown: string;
	}>;
} | null {
	const doc = getYDoc();
	const actor = actorForCaller(caller);

	requireAccessibleParent(caller, documentId);
	const document = crdtGetDocument(doc, documentId);
	if (!document) return null;

	const records = crdtListRecordsForParent(doc, documentId).map((r) => {
		const isPageLink = r.blockType === 'page-link' || r.blockType === 'page_link';
		const targetTitle =
			isPageLink && r.referencedRecordId
				? (crdtGetDocument(doc, r.referencedRecordId)?.title ?? 'Untitled')
				: '';
		const markdown = isPageLink
			? targetTitle
				? `[[${targetTitle}]]`
				: r.content
					? richTextToMarkdown(doc, r.content)
					: ''
			: r.content
				? richTextToMarkdown(doc, r.content)
				: '';
		return {
			id: r.id,
			blockType: r.blockType,
			checked: r.checked,
			collapsed: r.collapsed,
			referencedRecordId: r.referencedRecordId,
			markdown
		};
	});

	logAudit({ actor, action: 'get_document', targetRecordId: documentId });
	return {
		id: document.id,
		title: document.title,
		parentDocumentId: document.parentDocumentId,
		records
	};
}

export function listDocuments(caller: CallerIdentity): DocumentMeta[] {
	const doc = getYDoc();
	const docs = crdtListDocuments(doc);
	if (isAccessToken(caller)) {
		return docs.filter((d) => tokenAllowsParent(caller, d.id));
	}
	return docs;
}
