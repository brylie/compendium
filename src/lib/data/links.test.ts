import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
	createCollection,
	createDocument,
	createRecord,
	deleteDocument,
	updateDocumentTitle,
	updateRecordContent
} from './records';
import {
	RECORD_LINK_SCHEME,
	isLinkBroken,
	listIncomingLinks,
	listOutgoingLinks,
	resolveInternalLinkTarget
} from './links';
import type { ActorId } from './types';

const CURRENT_USER: ActorId = { kind: 'human', userId: 'brylie' };

describe('resolveInternalLinkTarget', () => {
	it('resolves a Document ID to its current title', () => {
		const doc = new Y.Doc();
		const target = createDocument(doc, { title: 'Original Title' });

		expect(resolveInternalLinkTarget(doc, target.id)).toEqual({
			id: target.id,
			kind: 'document',
			title: 'Original Title'
		});
	});

	it('resolves a Collection ID to its current title', () => {
		const doc = new Y.Doc();
		const collection = createCollection(doc, { title: 'Sprint Backlog', schema: [] });

		expect(resolveInternalLinkTarget(doc, collection.id)).toEqual({
			id: collection.id,
			kind: 'collection',
			title: 'Sprint Backlog'
		});
	});

	it('re-resolves the current title after a rename — a link is never retargeted or broken by a rename', () => {
		const doc = new Y.Doc();
		const target = createDocument(doc, { title: 'Draft' });

		updateDocumentTitle(doc, target.id, 'Published');

		expect(resolveInternalLinkTarget(doc, target.id)?.title).toBe('Published');
	});

	it('returns undefined once the target Document is deleted', () => {
		const doc = new Y.Doc();
		const target = createDocument(doc, { title: 'Temporary' });

		deleteDocument(doc, target.id);

		expect(resolveInternalLinkTarget(doc, target.id)).toBeUndefined();
	});

	it('returns undefined for an ID that never named anything', () => {
		const doc = new Y.Doc();
		expect(resolveInternalLinkTarget(doc, 'nonexistent-id')).toBeUndefined();
	});
});

describe('listOutgoingLinks', () => {
	it('collects a page_link block as one outgoing link', () => {
		const doc = new Y.Doc();
		const source = createDocument(doc, { title: 'Source' });
		const target = createDocument(doc, { title: 'Target' });
		const block = createRecord(
			doc,
			{ parentId: source.id, blockType: 'page_link', referencedRecordId: target.id },
			CURRENT_USER
		);

		const links = listOutgoingLinks(doc, source.id);
		expect(links).toEqual([
			{
				sourceRecordId: block.id,
				targetId: target.id,
				target: { id: target.id, kind: 'document', title: 'Target' }
			}
		]);
	});

	it('ignores a page_link block with no target set yet', () => {
		const doc = new Y.Doc();
		const source = createDocument(doc, { title: 'Source' });
		createRecord(doc, { parentId: source.id, blockType: 'page_link' }, CURRENT_USER);

		expect(listOutgoingLinks(doc, source.id)).toEqual([]);
	});

	it('collects an inline wiki-link mark from a paragraph block', () => {
		const doc = new Y.Doc();
		const source = createDocument(doc, { title: 'Source' });
		const target = createDocument(doc, { title: 'Target' });
		const block = createRecord(doc, { parentId: source.id, blockType: 'paragraph' }, CURRENT_USER);
		updateRecordContent(
			doc,
			block.id,
			{ runs: [{ text: 'Target', marks: { link: `${RECORD_LINK_SCHEME}${target.id}` } }] },
			CURRENT_USER
		);

		const links = listOutgoingLinks(doc, source.id);
		expect(links).toEqual([
			{
				sourceRecordId: block.id,
				targetId: target.id,
				target: { id: target.id, kind: 'document', title: 'Target' }
			}
		]);
	});

	it('marks a link whose target was deleted as broken via isLinkBroken, without dropping it from the list', () => {
		const doc = new Y.Doc();
		const source = createDocument(doc, { title: 'Source' });
		const target = createDocument(doc, { title: 'Target' });
		const block = createRecord(
			doc,
			{ parentId: source.id, blockType: 'page_link', referencedRecordId: target.id },
			CURRENT_USER
		);

		deleteDocument(doc, target.id);

		const links = listOutgoingLinks(doc, source.id);
		expect(links).toEqual([{ sourceRecordId: block.id, targetId: target.id, target: undefined }]);
		expect(isLinkBroken(links[0])).toBe(true);
	});

	it('does not treat a plain external link mark as an internal link', () => {
		const doc = new Y.Doc();
		const source = createDocument(doc, { title: 'Source' });
		const block = createRecord(doc, { parentId: source.id, blockType: 'paragraph' }, CURRENT_USER);
		updateRecordContent(
			doc,
			block.id,
			{ runs: [{ text: 'docs', marks: { link: 'https://example.com' } }] },
			CURRENT_USER
		);

		expect(listOutgoingLinks(doc, source.id)).toEqual([]);
	});
});

describe('listIncomingLinks', () => {
	it('finds both page_link and inline wiki-link references with their live source context', () => {
		const doc = new Y.Doc();
		const target = createDocument(doc, { id: 'target', title: 'Target' });
		const pageSource = createDocument(doc, { id: 'page-source', title: 'Page source' });
		const inlineSource = createDocument(doc, { id: 'inline-source', title: 'Inline source' });
		const pageLink = createRecord(
			doc,
			{ parentId: pageSource.id, blockType: 'page_link', referencedRecordId: target.id },
			CURRENT_USER
		);
		const inlineLink = createRecord(
			doc,
			{ parentId: inlineSource.id, blockType: 'paragraph' },
			CURRENT_USER
		);
		updateRecordContent(
			doc,
			inlineLink.id,
			{
				runs: [
					{
						text: 'See the target for details.',
						marks: { link: `${RECORD_LINK_SCHEME}${target.id}` }
					}
				]
			},
			CURRENT_USER
		);

		expect(listIncomingLinks(doc, target.id)).toEqual([
			{
				sourceDocumentId: pageSource.id,
				sourceDocumentTitle: 'Page source',
				sourceRecordId: pageLink.id,
				context: 'Page link'
			},
			{
				sourceDocumentId: inlineSource.id,
				sourceDocumentTitle: 'Inline source',
				sourceRecordId: inlineLink.id,
				context: 'See the target for details.'
			}
		]);
	});

	it('keeps a backlink attached to its ID through source rename and ignores deleted sources', () => {
		const doc = new Y.Doc();
		const target = createDocument(doc, { id: 'target', title: 'Target' });
		const source = createDocument(doc, { id: 'source', title: 'Original source' });
		createRecord(
			doc,
			{ parentId: source.id, blockType: 'page_link', referencedRecordId: target.id },
			CURRENT_USER
		);

		updateDocumentTitle(doc, source.id, 'Renamed source');
		expect(listIncomingLinks(doc, target.id)).toMatchObject([
			{ sourceDocumentId: source.id, sourceDocumentTitle: 'Renamed source' }
		]);

		deleteDocument(doc, source.id);
		expect(listIncomingLinks(doc, target.id)).toEqual([]);
	});

	it('does not confuse links when Documents share a title', () => {
		const doc = new Y.Doc();
		const first = createDocument(doc, { id: 'first', title: 'Notes' });
		const second = createDocument(doc, { id: 'second', title: 'Notes' });
		const source = createDocument(doc, { id: 'source', title: 'Source' });
		createRecord(
			doc,
			{ parentId: source.id, blockType: 'page_link', referencedRecordId: second.id },
			CURRENT_USER
		);

		expect(listIncomingLinks(doc, first.id)).toEqual([]);
		expect(listIncomingLinks(doc, second.id)).toHaveLength(1);
	});
});
