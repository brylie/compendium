import { getYDoc } from '$lib/server/ydoc';
import {
	createCollection as crdtCreateCollection,
	deleteCollection as crdtDeleteCollection,
	getCollection as crdtGetCollection,
	listCollections as crdtListCollections,
	listRecordsForParent as crdtListRecordsForParent,
	updateCollectionTitle as crdtUpdateCollectionTitle
} from '$lib/data/records';
import { logAudit } from '$lib/server/audit';
import { grantCollectionAccess, tokenAllowsParent } from '$lib/mcp/tokens';
import type { CollectionMeta, PropertyDefinition, WorkspaceRecord } from '$lib/data/types';
import {
	actorForCaller,
	isAccessToken,
	requireAccessibleParent,
	type CallerIdentity
} from './permissions';

export interface CreateCollectionInput {
	id?: string;
	title: string;
	schema?: PropertyDefinition[];
}

export function createCollection(
	caller: CallerIdentity,
	input: CreateCollectionInput
): CollectionMeta {
	const doc = getYDoc();
	const actor = actorForCaller(caller);

	const collection = crdtCreateCollection(doc, {
		id: input.id,
		title: input.title,
		schema: input.schema ?? []
	});

	if (isAccessToken(caller)) {
		grantCollectionAccess(caller.tokenHash, collection.id);
		if (!caller.allowedCollectionIds.includes(collection.id)) {
			caller.allowedCollectionIds.push(collection.id);
		}
	}

	logAudit({ actor, action: 'create_collection', targetRecordId: collection.id });
	return collection;
}

export function listCollections(caller: CallerIdentity): CollectionMeta[] {
	const doc = getYDoc();
	const collections = crdtListCollections(doc);
	if (isAccessToken(caller)) {
		return collections.filter((c) => tokenAllowsParent(caller, c.id));
	}
	return collections;
}

export function queryCollection(
	caller: CallerIdentity,
	collectionId: string
): {
	collection: CollectionMeta | undefined;
	records: WorkspaceRecord[];
} {
	const doc = getYDoc();
	const actor = actorForCaller(caller);

	requireAccessibleParent(caller, collectionId, 'query_collection');
	const collection = crdtGetCollection(doc, collectionId);
	const records = crdtListRecordsForParent(doc, collectionId);

	logAudit({ actor, action: 'query_collection', targetRecordId: collectionId });
	return { collection, records };
}

export function deleteCollection(caller: CallerIdentity, collectionId: string): void {
	const doc = getYDoc();
	const actor = actorForCaller(caller);

	requireAccessibleParent(caller, collectionId, 'delete_collection');
	crdtDeleteCollection(doc, collectionId);
	logAudit({ actor, action: 'delete_collection', targetRecordId: collectionId });
}

export function updateCollectionTitle(
	caller: CallerIdentity,
	collectionId: string,
	title: string
): void {
	const doc = getYDoc();
	const actor = actorForCaller(caller);

	requireAccessibleParent(caller, collectionId, 'update_collection_title');
	crdtUpdateCollectionTitle(doc, collectionId, title);
	logAudit({
		actor,
		action: 'update_collection_title',
		targetRecordId: collectionId,
		diff: { title }
	});
}
