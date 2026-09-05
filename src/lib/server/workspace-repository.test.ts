import { describe, expect, it } from 'vitest';
import { createDocument as rawCrdtCreateDocument } from '$lib/data/document-ops';
import { createCollection as rawCrdtCreateCollection } from '$lib/data/collection-ops';
import { createDocument, createCollection } from '$lib/services';
import type { ActorId } from '$lib/data/types';
import { TEST_ORIGIN, transactWithOrigin } from '$lib/mutation-origin';
import { resolveWorkspaceContext } from './workspace-store';
import { createSpace, listCatalogDocuments } from './catalog';
import {
	fanOutCatalogedAndUncataloged,
	listWorkspaceDocuments,
	listWorkspaceCollections
} from './workspace-repository';

const human: ActorId = { kind: 'human', userId: 'brylie' };
const allowAll = () => true;

function crdtCreateDocument(...args: Parameters<typeof rawCrdtCreateDocument>) {
	return transactWithOrigin(args[0], TEST_ORIGIN, () => rawCrdtCreateDocument(...args));
}

function crdtCreateCollection(...args: Parameters<typeof rawCrdtCreateCollection>) {
	return transactWithOrigin(args[0], TEST_ORIGIN, () => rawCrdtCreateCollection(...args));
}

describe('listWorkspaceDocuments', () => {
	it('includes both catalog-listed and uncataloged Documents when spaceId is omitted', () => {
		const { doc, workspaceId, defaultSpaceId } = resolveWorkspaceContext();
		const cataloged = createDocument(human, { title: 'Cataloged Doc' });
		const uncataloged = crdtCreateDocument(doc, { title: 'Uncataloged Doc' });

		const results = listWorkspaceDocuments({
			workspaceId,
			defaultSpaceId,
			defaultDoc: doc,
			allowed: allowAll
		});

		expect(results.some((d) => d.id === cataloged.id)).toBe(true);
		expect(results.some((d) => d.id === uncataloged.id)).toBe(true);
	});

	it('skips the uncataloged fallback when a non-default spaceId is requested', () => {
		const { doc, workspaceId, defaultSpaceId } = resolveWorkspaceContext();
		const otherSpace = createSpace(workspaceId, 'Other Space');
		const cataloged = createDocument(human, { title: 'Other-Space Doc', spaceId: otherSpace.id });
		const uncataloged = crdtCreateDocument(doc, { title: 'Uncataloged Doc 2' });

		const results = listWorkspaceDocuments({
			workspaceId,
			spaceId: otherSpace.id,
			defaultSpaceId,
			defaultDoc: doc,
			allowed: allowAll
		});

		expect(results.some((d) => d.id === cataloged.id)).toBe(true);
		expect(results.some((d) => d.id === uncataloged.id)).toBe(false);
	});

	it('still runs the uncataloged fallback when the requested spaceId is the workspace default', () => {
		const { doc, workspaceId, defaultSpaceId } = resolveWorkspaceContext();
		const uncataloged = crdtCreateDocument(doc, { title: 'Uncataloged Doc 3' });

		const results = listWorkspaceDocuments({
			workspaceId,
			spaceId: defaultSpaceId,
			defaultSpaceId,
			defaultDoc: doc,
			allowed: allowAll
		});

		expect(results.some((d) => d.id === uncataloged.id)).toBe(true);
	});

	it('applies the permission predicate to both catalog and uncataloged items', () => {
		const { doc, workspaceId, defaultSpaceId } = resolveWorkspaceContext();
		const cataloged = createDocument(human, { title: 'Denied Doc' });
		const uncataloged = crdtCreateDocument(doc, { title: 'Denied Uncataloged Doc' });

		const results = listWorkspaceDocuments({
			workspaceId,
			defaultSpaceId,
			defaultDoc: doc,
			allowed: () => false
		});

		expect(results.some((d) => d.id === cataloged.id)).toBe(false);
		expect(results.some((d) => d.id === uncataloged.id)).toBe(false);
	});
});

describe('listWorkspaceCollections', () => {
	it('hydrates catalog-listed Collections with their full schema, not just the catalog stub', () => {
		const { doc, workspaceId, defaultSpaceId } = resolveWorkspaceContext();
		const cataloged = createCollection(human, {
			title: 'Cataloged Collection',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});

		const results = listWorkspaceCollections({
			workspaceId,
			defaultSpaceId,
			defaultDoc: doc,
			allowed: allowAll
		});

		const found = results.find((c) => c.id === cataloged.id);
		expect(found?.schema).toEqual([{ key: 'name', label: 'Name', type: 'text' }]);
	});

	it('includes an uncataloged Collection alongside cataloged ones', () => {
		const { doc, workspaceId, defaultSpaceId } = resolveWorkspaceContext();
		const uncataloged = crdtCreateCollection(doc, {
			title: 'Uncataloged Collection',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});

		const results = listWorkspaceCollections({
			workspaceId,
			defaultSpaceId,
			defaultDoc: doc,
			allowed: allowAll
		});

		expect(results.some((c) => c.id === uncataloged.id)).toBe(true);
	});
});

describe('fanOutCatalogedAndUncataloged', () => {
	it('resolves each catalog item to the Y.Doc its own shard actually lives in', () => {
		const { doc, workspaceId, defaultSpaceId } = resolveWorkspaceContext();
		const cataloged = createDocument(human, { title: 'Fanout Doc' });

		const items = fanOutCatalogedAndUncataloged({
			workspaceId,
			spaceId: undefined,
			defaultSpaceId,
			defaultDoc: doc,
			listCatalog: listCatalogDocuments,
			listUncataloged: () => [],
			getId: (m) => m.id,
			getSpaceId: (m) => m.spaceId,
			allowed: allowAll,
			resolveShardDoc: true
		});

		const found = items.find((item) => item.meta.id === cataloged.id);
		expect(found?.doc).toBeDefined();
		// A Document's shard is its own id (#120) — its resolved doc should be
		// a live workspace context, not silently falling back to defaultDoc.
		expect(found?.doc).toBe(resolveWorkspaceContext({ workspaceId, shardId: cataloged.id }).doc);
	});
});
