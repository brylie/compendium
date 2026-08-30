import { resolveWorkspaceContext } from '$lib/server/workspace-store';
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
import {
	recordCatalogDocumentCreated,
	recordCatalogDocumentDeleted,
	recordCatalogDocumentMoved,
	recordCatalogDocumentTitleChanged,
	reserveDocumentLocator
} from '$lib/server/catalog';
import { grantDocumentAccess, tokenAllowsParent } from '$lib/mcp/tokens';
import { richTextToMarkdown } from '$lib/mcp/markdown-transcode';
import { resolveInternalLinkTarget } from '$lib/data/links';
import type { DocumentMeta, EmbeddedViewConfig } from '$lib/data/types';
import { nanoid } from 'nanoid';
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
	const { doc, workspaceId, shardId, defaultSpaceId } = resolveWorkspaceContext();
	const actor = actorForCaller(caller);

	// Decision: In single-tenant Phase 0/1, any authenticated caller is permitted
	// to create top-level documents; when nested, access to parentDocumentId is verified.
	if (input.parentDocumentId) {
		requireAccessibleParent(caller, input.parentDocumentId, 'create_document');
	}

	// Reserve the id in the catalog's workspace-wide record locator *before*
	// any Y.Doc content is written — throws RecordIdConflictError on a
	// collision instead of the Y.Doc primitive's prior silent overwrite (see
	// docs/specifications/workspace-sharding.md §3.1).
	const id = input.id ?? nanoid();
	reserveDocumentLocator(workspaceId, defaultSpaceId, id, shardId);

	const document = crdtCreateDocument(doc, {
		id,
		title: input.title,
		parentDocumentId: input.parentDocumentId,
		afterDocumentId: input.afterDocumentId
	});

	recordCatalogDocumentCreated({
		workspaceId,
		spaceId: defaultSpaceId,
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

export function moveDocument(
	caller: CallerIdentity,
	documentId: string,
	options: { parentDocumentId?: string; afterDocumentId?: string }
): void {
	const { doc, workspaceId } = resolveWorkspaceContext();
	const actor = actorForCaller(caller);

	requireAccessibleParent(caller, documentId, 'move_document');
	if (options.parentDocumentId) {
		requireAccessibleParent(caller, options.parentDocumentId, 'move_document');
	}

	crdtUpdateDocumentParent(doc, documentId, options.parentDocumentId, options.afterDocumentId);
	const moved = crdtGetDocument(doc, documentId);
	if (moved) {
		recordCatalogDocumentMoved(workspaceId, documentId, moved.parentDocumentId, moved.order);
	}
	logAudit({
		actor,
		action: 'move_document',
		targetRecordId: documentId,
		diff: options
	});
}

export function deleteDocument(caller: CallerIdentity, documentId: string): void {
	const { doc, workspaceId } = resolveWorkspaceContext();
	const actor = actorForCaller(caller);

	requireAccessibleParent(caller, documentId, 'delete_document');
	crdtDeleteDocument(doc, documentId);
	recordCatalogDocumentDeleted(workspaceId, documentId);
	logAudit({ actor, action: 'delete_document', targetRecordId: documentId });
}

export function updateDocumentTitle(
	caller: CallerIdentity,
	documentId: string,
	title: string
): void {
	const { doc, workspaceId } = resolveWorkspaceContext();
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
	}>;
} | null {
	const { doc } = resolveWorkspaceContext();
	const actor = actorForCaller(caller);

	requireAccessibleParent(caller, documentId, 'get_document');
	const document = crdtGetDocument(doc, documentId);
	if (!document) return null;

	const records = crdtListRecordsForParent(doc, documentId).map((r) => {
		const isPageLink = r.blockType === 'page_link';
		const isCollectionView = r.blockType === 'collection_view';
		// A referenced target can be any Document or Collection, not just ones
		// under this documentId — an out-of-scope target must not leak its
		// title/id/schema to a token that was never granted access to it.
		const targetInScope =
			!r.referencedRecordId ||
			!isAccessToken(caller) ||
			tokenAllowsParent(caller, r.referencedRecordId);
		const resolvedTarget =
			(isPageLink || isCollectionView) && r.referencedRecordId && targetInScope
				? resolveInternalLinkTarget(doc, r.referencedRecordId)
				: undefined;
		const linkedTarget = isCollectionView
			? resolvedTarget?.kind === 'collection'
				? resolvedTarget
				: undefined
			: resolvedTarget;
		const linkBroken =
			(isPageLink || isCollectionView) && r.referencedRecordId && targetInScope && !linkedTarget
				? true
				: undefined;
		const markdown = isPageLink
			? r.referencedRecordId && targetInScope
				? `[[${linkedTarget?.title ?? 'Deleted page'}]]`
				: r.content
					? richTextToMarkdown(doc, r.content)
					: ''
			: isCollectionView
				? r.referencedRecordId && targetInScope
					? `[collection view: ${linkedTarget?.title ?? 'Deleted collection'}]`
					: '[collection view: unconfigured]'
				: r.content
					? richTextToMarkdown(doc, r.content)
					: '';
		return {
			id: r.id,
			blockType: r.blockType,
			checked: r.checked,
			collapsed: r.collapsed,
			referencedRecordId: targetInScope ? r.referencedRecordId : undefined,
			linkBroken,
			viewConfig: isCollectionView && linkedTarget ? r.viewConfig : undefined,
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
	const { doc } = resolveWorkspaceContext();
	const docs = crdtListDocuments(doc);
	if (isAccessToken(caller)) {
		return docs.filter((d) => tokenAllowsParent(caller, d.id));
	}
	return docs;
}
