import * as Y from 'yjs';
import { generateKeyBetween } from 'fractional-indexing';
import { nanoid } from 'nanoid';
import type { ChildPageNode, ChildPagesDepth, DocumentMeta, DocumentTreeNode } from './types';
import { type TypedYMap, typedYMap } from './yjs-typed';
import { type DocumentYShape, documentsMap, recordsMap } from './yjs-shapes';
import { NotFoundError } from './errors';

/** All Documents in the workspace, sorted into sibling order by their fractional-index `order` field. */
export function listDocuments(doc: Y.Doc): DocumentMeta[] {
	const out: DocumentMeta[] = [];
	documentsMap(doc).forEach((ymeta, id) => {
		out.push(readDocumentMeta(id, ymeta));
	});
	return out.sort((a, b) => a.order.localeCompare(b.order));
}

/** Looks up one Document's metadata by id, or undefined if it doesn't exist. */
export function getDocument(doc: Y.Doc, id: string): DocumentMeta | undefined {
	const ymeta = documentsMap(doc).get(id);
	return ymeta ? readDocumentMeta(id, ymeta) : undefined;
}

function readDocumentMeta(id: string, ymeta: TypedYMap<DocumentYShape>): DocumentMeta {
	const recordIds = ymeta.get('recordIds');
	return {
		id,
		title: ymeta.get('title') ?? 'Untitled',
		parentDocumentId: ymeta.get('parentDocumentId') ?? undefined,
		order: ymeta.get('order') ?? 'a0',
		recordIds: recordIds ? recordIds.toArray() : []
	};
}

/**
 * Computes a new fractional-index order value for a document being inserted
 * into (or moved within) a sibling list — extracted from createDocument's
 * inline logic so a caller with siblings sourced from *outside* this Y.Doc
 * (the catalog, once Documents are sharded and true siblings may live in
 * different shards entirely) can compute the same value createDocument would
 * have computed for a single, unsharded doc.
 */
export function computeSiblingOrder(siblings: DocumentMeta[], afterDocumentId?: string): string {
	let before: string | null = null;
	let after: string | null = null;

	if (afterDocumentId) {
		const idx = siblings.findIndex((s) => s.id === afterDocumentId);
		if (idx !== -1) {
			before = siblings[idx].order;
			after = idx + 1 < siblings.length ? siblings[idx + 1].order : null;
		}
	} else if (siblings.length > 0) {
		before = siblings[siblings.length - 1].order;
	}

	return generateKeyBetween(before, after);
}

/** Creates a new Document, inserting it into its parent's sibling order (at the end, or after `afterDocumentId`) via a fresh fractional-index `order`. */
export function createDocument(
	doc: Y.Doc,
	input: {
		id?: string;
		title: string;
		parentDocumentId?: string;
		afterDocumentId?: string;
		// Pre-computed order, for a caller (services/documents.ts) that already
		// resolved true cross-shard siblings via the catalog — see
		// computeSiblingOrder's doc comment. Falls back to this doc's own
		// listDocuments() when omitted, correct for any caller (tests, a
		// not-yet-sharded doc) where every sibling genuinely lives in `doc`.
		order?: string;
	}
): DocumentMeta {
	const id = input.id ?? nanoid();
	// `||`, not `??`: a caller (e.g. an MCP client's `parentDocumentId:
	// z.string().optional()`) can pass `''` instead of omitting the field —
	// `??` would leave it as a truthy-but-invalid id, computing sibling
	// order among documents with parentDocumentId === '' (none) instead of
	// among the real root siblings.
	// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
	const parentDocumentId = input.parentDocumentId || undefined;

	return doc.transact(() => {
		const order =
			input.order ??
			computeSiblingOrder(
				listDocuments(doc).filter((d) => d.parentDocumentId === parentDocumentId),
				input.afterDocumentId
			);

		const ymeta = typedYMap<DocumentYShape>(new Y.Map<unknown>());
		ymeta.set('id', id);
		ymeta.set('title', input.title);
		if (parentDocumentId) {
			ymeta.set('parentDocumentId', parentDocumentId);
		}
		ymeta.set('order', order);
		ymeta.set('recordIds', new Y.Array<string>());
		documentsMap(doc).set(id, ymeta.raw);

		return {
			id,
			title: input.title,
			parentDocumentId,
			order,
			recordIds: []
		};
	});
}

/** Renames a Document. Throws NotFoundError if it doesn't exist. */
export function updateDocumentTitle(doc: Y.Doc, id: string, title: string): void {
	const ymeta = documentsMap(doc).get(id);
	if (!ymeta) throw new NotFoundError(`Document ${id} not found`);
	ymeta.set('title', title);
}

/**
 * `order` — see createDocument's doc comment on computeSiblingOrder: a
 * caller with catalog-sourced cross-shard siblings passes the pre-computed
 * value; omitted, this falls back to `doc`'s own listDocuments().
 */
export function updateDocumentParent(
	doc: Y.Doc,
	id: string,
	parentDocumentId?: string,
	afterDocumentId?: string,
	order?: string
): void {
	const ymeta = documentsMap(doc).get(id);
	if (!ymeta) throw new NotFoundError(`Document ${id} not found`);

	doc.transact(() => {
		// Same `||` reasoning as createDocument above: a caller-supplied `''`
		// must match real root siblings (parentDocumentId === undefined), not
		// filter down to nothing.
		// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
		const normalizedParentDocumentId = parentDocumentId || undefined;
		const resolvedOrder =
			order ??
			computeSiblingOrder(
				listDocuments(doc)
					.filter((d) => d.id !== id)
					.filter((d) => d.parentDocumentId === normalizedParentDocumentId),
				afterDocumentId
			);

		if (parentDocumentId) {
			ymeta.set('parentDocumentId', parentDocumentId);
		} else {
			ymeta.delete('parentDocumentId');
		}
		ymeta.set('order', resolvedOrder);
	});
}

/** Deletes a Document, its records, and every descendant Document (recursively) with their own records. */
export function deleteDocument(doc: Y.Doc, id: string): void {
	doc.transact(() => {
		const meta = getDocument(doc, id);
		if (!meta) return;

		// Delete descendant documents recursively
		const allDocs = listDocuments(doc);
		const childDocs = allDocs.filter((d) => d.parentDocumentId === id);
		for (const child of childDocs) {
			deleteDocument(doc, child.id);
		}

		for (const recordId of meta.recordIds) {
			recordsMap(doc).delete(recordId);
		}
		documentsMap(doc).delete(id);
	});
}

/** Assembles a flat list of Documents into a parent/child tree (sidebar nesting), computing each node's depth level. */
export function buildDocumentTree(documents: DocumentMeta[]): DocumentTreeNode[] {
	const sorted = [...documents].sort((a, b) => a.order.localeCompare(b.order));
	const map = new Map<string, DocumentTreeNode>();

	for (const doc of sorted) {
		map.set(doc.id, {
			...doc,
			children: [],
			level: 0
		});
	}

	const roots: DocumentTreeNode[] = [];

	for (const doc of sorted) {
		const node = map.get(doc.id)!;
		if (doc.parentDocumentId && map.has(doc.parentDocumentId)) {
			const parent = map.get(doc.parentDocumentId)!;
			node.level = parent.level + 1;
			parent.children.push(node);
		} else {
			node.level = 0;
			roots.push(node);
		}
	}

	// Update levels recursively in case of deep tree
	function setLevel(nodes: DocumentTreeNode[], lvl: number) {
		for (const n of nodes) {
			n.level = lvl;
			setLevel(n.children, lvl + 1);
		}
	}
	setLevel(roots, 0);

	return roots;
}

function trimChildPagesDepth(nodes: DocumentTreeNode[], remaining: number): ChildPageNode[] {
	if (remaining <= 0) return [];
	return nodes.map((n) => ({
		id: n.id,
		title: n.title,
		children: trimChildPagesDepth(n.children, remaining - 1)
	}));
}

/**
 * Resolves a child_pages block's rendered listing (issue #43): `targetDocumentId`'s
 * immediate children (depth 1, the default), N levels of nesting, or its whole subtree
 * (`depth: 'unlimited'`) — reusing buildDocumentTree's own sorted, nested tree rather than
 * re-walking `documents` from scratch. `targetDocumentId` not being present in `documents`
 * at all (deleted, or filtered out by a caller's permission scope) resolves to an empty
 * list here — callers that need to distinguish "target missing" from "no children yet" do
 * that check independently against the same `documents` array before calling this.
 */
export function resolveChildPages(
	documents: DocumentMeta[],
	targetDocumentId: string,
	depth: ChildPagesDepth
): ChildPageNode[] {
	const tree = buildDocumentTree(documents);
	function findNode(nodes: DocumentTreeNode[], id: string): DocumentTreeNode | undefined {
		for (const node of nodes) {
			if (node.id === id) return node;
			const found = findNode(node.children, id);
			if (found) return found;
		}
		return undefined;
	}
	const children = findNode(tree, targetDocumentId)?.children ?? [];
	return trimChildPagesDepth(children, depth === 'unlimited' ? Infinity : depth);
}
