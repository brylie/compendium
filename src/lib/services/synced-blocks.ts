import type { RequestContext } from '$lib/server/request-context';
import type * as Y from 'yjs';
import { getDocument } from '$lib/data/document-ops';
import { getRecord, getRecordYText, resolveOwningParentId } from '$lib/data/record-ops';
import { plainText, yTextToRichText } from '$lib/data/richtext';
import type { Backlink } from '$lib/data/links';
import { listSyncedBlockInstancesAcrossShards } from '$lib/server/synced-block-index';
import { resolveRecordWorkspaceContext } from './permissions';

// The cross-shard read half of #242: src/lib/data/links.ts's
// listSyncedBlockInstances only ever sees the current Y.Doc, so a caller that
// needs the true, workspace-wide "used in N places" answer (or a synced_block
// instance's own source, when that source lives in a different Document's
// shard) resolves it here instead — combining the durable
// synced_block_instance locator (server/synced-block-index.ts) with each
// hit's actual owning Document, resolved through its own shard.
//
// Read-only and unauthenticated the same way GET /api/documents/[id]/shard
// and /api/collections/[id]/shard already are (see those routes) — this
// exists to help *render* a location a client is already looking at, not to
// authorize a mutation, so it follows that same precedent rather than
// introducing a permission check this feature's siblings don't have either.

export interface SyncGroup {
	/** The resolved location of `recordId` itself, when it's still a real record with a real owning Document — absent for an id that no longer resolves to anything. */
	source?: Backlink;
	/** Every synced_block instance (any shard) currently mirroring `recordId`. */
	instances: Backlink[];
}

/** Builds one `Backlink`-shaped location for `recordId`, resolved against whichever `doc` it actually lives in. Returns undefined when the record or its owning Document no longer resolves. */
function locationFor(doc: Y.Doc, recordId: string): Backlink | undefined {
	const record = getRecord(doc, recordId);
	if (!record) return undefined;
	const ownerDocumentId = resolveOwningParentId(doc, record.parentId);
	const ownerDocument = getDocument(doc, ownerDocumentId);
	if (!ownerDocument) return undefined;
	const ytext = getRecordYText(doc, recordId);
	const trimmed = ytext ? plainText(yTextToRichText(ytext)).trim() : '';
	return {
		sourceDocumentId: ownerDocument.id,
		sourceDocumentTitle: ownerDocument.title,
		sourceRecordId: recordId,
		context: trimmed || (record.blockType === 'synced_block' ? 'Synced block' : 'Synced source')
	};
}

/**
 * Resolves each of `recordIds`' sync group — its own location plus every
 * synced_block instance mirroring it, anywhere in the workspace — for a
 * client that already knows which ids are worth asking about (a Document's
 * own flattened block list, plus every synced_block's referencedRecordId
 * among them; see the `/api/sync-groups` route). An id with neither a
 * resolvable location nor any instance is omitted from the result entirely,
 * so an ordinary block (the overwhelming majority) costs the caller nothing
 * to render.
 */
export function resolveSyncGroups(
	context: RequestContext,
	recordIds: string[]
): Record<string, SyncGroup> {
	const uniqueIds = [...new Set(recordIds)];
	const rows = listSyncedBlockInstancesAcrossShards(context.workspaceId, uniqueIds);
	const rowsBySource = new Map<string, typeof rows>();
	for (const row of rows) {
		const list = rowsBySource.get(row.sourceRecordId);
		if (list) list.push(row);
		else rowsBySource.set(row.sourceRecordId, [row]);
	}

	const docsByShard = new Map<string, Y.Doc>();
	function docForShard(shardId: string): Y.Doc {
		let doc = docsByShard.get(shardId);
		if (!doc) {
			doc = context.workspaceStore.resolve({ workspaceId: context.workspaceId, shardId }).doc;
			docsByShard.set(shardId, doc);
		}
		return doc;
	}

	const result: Record<string, SyncGroup> = {};
	for (const id of uniqueIds) {
		const { doc: ownDoc } = resolveRecordWorkspaceContext(context, id);
		const source = locationFor(ownDoc, id);

		const instances: Backlink[] = [];
		for (const row of rowsBySource.get(id) ?? []) {
			const instanceDoc = docForShard(row.instanceShardId);
			const instanceRecord = getRecord(instanceDoc, row.instanceRecordId);
			// A stale row (instance deleted/retargeted since last indexed, not
			// yet reconciled) — skip rather than surface a broken entry.
			if (instanceRecord?.blockType !== 'synced_block') continue;
			const location = locationFor(instanceDoc, row.instanceRecordId);
			if (location) instances.push(location);
		}

		if (source || instances.length > 0) result[id] = { source, instances };
	}
	return result;
}
