import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
	createDocument as crdtCreateDocument,
	getDocument as crdtGetDocument
} from '$lib/data/document-ops';
import {
	createRecord as crdtCreateRecord,
	deleteRecord as crdtDeleteRecord
} from '$lib/data/record-ops';
import { ensureCatalogBootstrapped, reserveRecordLocator, resolveShardForRecord } from './catalog';
import { attachRecordLocatorObserver } from './record-locator-observer';
import {
	remoteUiOrigin,
	SERVICE_ORIGIN,
	transactWithOrigin,
	UnknownMutationOriginError
} from '../mutation-origin';
import type { ActorId } from '$lib/data/types';

const WS = 'default';
const SHARD = 'record-locator-observer-test-shard';
const REMOTE_UI_ORIGIN = remoteUiOrigin('record-locator-observer-test');
const human: ActorId = { kind: 'human', userId: 'brylie' };

function bootstrap(doc: Y.Doc) {
	attachRecordLocatorObserver(WS, spaceIdFor(doc), SHARD, doc);
}

// ensureCatalogBootstrapped is idempotent workspace-wide (see catalog.ts), so
// every test in this file shares one Space id regardless of call order.
function spaceIdFor(doc: Y.Doc): string {
	return ensureCatalogBootstrapped(WS, SHARD, doc).defaultSpaceId;
}

describe('record-locator-observer: reserving a locator for direct UI record creation (#253)', () => {
	let doc: Y.Doc;

	beforeEach(() => {
		doc = new Y.Doc();
		bootstrap(doc);
	});

	afterEach(() => {
		doc.destroy();
	});

	it('reserves a locator for a record created via direct (remote) UI mutation, so a bare recordId resolves to this shard', () => {
		const docMeta = transactWithOrigin(doc, REMOTE_UI_ORIGIN, () =>
			crdtCreateDocument(doc, { title: 'Human Doc' })
		);
		expect(resolveShardForRecord(WS, docMeta.id)).toBeUndefined(); // Documents aren't record-kind

		const block = transactWithOrigin(doc, REMOTE_UI_ORIGIN, () =>
			crdtCreateRecord(doc, { parentId: docMeta.id, blockType: 'paragraph' }, human)
		);

		expect(resolveShardForRecord(WS, block.id)).toEqual({ shardId: SHARD });
	});

	it('does not conflict with a service-origin create that already reserved its own locator', () => {
		const docMeta = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			crdtCreateDocument(doc, { title: 'Service Doc' })
		);
		const id = 'service-created-record';
		reserveRecordLocator(WS, spaceIdFor(doc), id, SHARD);

		expect(() =>
			transactWithOrigin(doc, SERVICE_ORIGIN, () =>
				crdtCreateRecord(doc, { id, parentId: docMeta.id, blockType: 'paragraph' }, human)
			)
		).not.toThrow();
		expect(resolveShardForRecord(WS, id)).toEqual({ shardId: SHARD });
	});

	it('does not reserve a locator for a record deletion', () => {
		// A separate, not-yet-observed doc: the record is created before the
		// observer attaches, so it genuinely starts with no locator at all —
		// proving deletion doesn't reserve one, rather than merely leaving an
		// already-reserved one (from the shared beforeEach's own creation)
		// untouched.
		const freshDoc = new Y.Doc();
		const docMeta = transactWithOrigin(freshDoc, REMOTE_UI_ORIGIN, () =>
			crdtCreateDocument(freshDoc, { title: 'Human Doc' })
		);
		const block = transactWithOrigin(freshDoc, REMOTE_UI_ORIGIN, () =>
			crdtCreateRecord(freshDoc, { parentId: docMeta.id, blockType: 'paragraph' }, human)
		);
		expect(resolveShardForRecord(WS, block.id)).toBeUndefined();

		attachRecordLocatorObserver(WS, spaceIdFor(freshDoc), SHARD, freshDoc);
		transactWithOrigin(freshDoc, REMOTE_UI_ORIGIN, () => crdtDeleteRecord(freshDoc, block.id));

		expect(crdtGetDocument(freshDoc, docMeta.id)?.recordIds).not.toContain(block.id);
		expect(resolveShardForRecord(WS, block.id)).toBeUndefined();
		freshDoc.destroy();
	});

	it('rejects an unregistered origin even when it has a recognized source name', () => {
		expect(() =>
			doc.transact(() => doc.getMap('records').set('bad', new Y.Map()), { source: 'local-ui' })
		).toThrow(UnknownMutationOriginError);
	});
});
