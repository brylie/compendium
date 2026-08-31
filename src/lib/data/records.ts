import * as Y from 'yjs';
import { generateKeyBetween } from 'fractional-indexing';
import { nanoid } from 'nanoid';
import type {
	ActorId,
	BlockType,
	CollectionMeta,
	DocumentMeta,
	DocumentTreeNode,
	EmbeddedViewConfig,
	ParentKind,
	PropertyDefinition,
	PropertyType,
	PropertyValue,
	RichText,
	WorkspaceRecord
} from './types';
import { applyRichTextToYText, yTextToRichText } from './richtext';
import { nextSelectOptionColor } from './select-colors';

const DOCUMENTS = 'documents';
const COLLECTIONS = 'collections';
const RECORDS = 'records';

// Properties are stored as individual `prop:<key>` entries on the record's
// Y.Map, rather than one JSON blob under a single key, so two humans editing
// different properties of the same row concurrently each merge (Y.Map's
// per-key LWW) instead of one clobbering the other's unrelated edit.
const PROP_PREFIX = 'prop:';

function documentsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
	return doc.getMap(DOCUMENTS);
}
function collectionsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
	return doc.getMap(COLLECTIONS);
}
function recordsMap(doc: Y.Doc): Y.Map<Y.Map<unknown>> {
	return doc.getMap(RECORDS);
}

export class NotFoundError extends Error {}
export class PermissionError extends Error {}
export class ValidationError extends Error {}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export function listDocuments(doc: Y.Doc): DocumentMeta[] {
	const out: DocumentMeta[] = [];
	documentsMap(doc).forEach((ymeta, id) => {
		out.push(readDocumentMeta(id, ymeta as Y.Map<unknown>));
	});
	return out.sort((a, b) => a.order.localeCompare(b.order));
}

export function getDocument(doc: Y.Doc, id: string): DocumentMeta | undefined {
	const ymeta = documentsMap(doc).get(id) as Y.Map<unknown> | undefined;
	return ymeta ? readDocumentMeta(id, ymeta) : undefined;
}

function readDocumentMeta(id: string, ymeta: Y.Map<unknown>): DocumentMeta {
	const recordIds = ymeta.get('recordIds') as Y.Array<string> | undefined;
	return {
		id,
		title: (ymeta.get('title') as string) ?? 'Untitled',
		parentDocumentId: (ymeta.get('parentDocumentId') as string | undefined) || undefined,
		order: (ymeta.get('order') as string) ?? 'a0',
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
	const parentDocumentId = input.parentDocumentId || undefined;

	return doc.transact(() => {
		const order =
			input.order ??
			computeSiblingOrder(
				listDocuments(doc).filter((d) => d.parentDocumentId === parentDocumentId),
				input.afterDocumentId
			);

		const ymeta = new Y.Map<unknown>();
		ymeta.set('id', id);
		ymeta.set('title', input.title);
		if (parentDocumentId) {
			ymeta.set('parentDocumentId', parentDocumentId);
		}
		ymeta.set('order', order);
		ymeta.set('recordIds', new Y.Array<string>());
		documentsMap(doc).set(id, ymeta);

		return {
			id,
			title: input.title,
			parentDocumentId,
			order,
			recordIds: []
		};
	});
}

export function updateDocumentTitle(doc: Y.Doc, id: string, title: string): void {
	const ymeta = documentsMap(doc).get(id) as Y.Map<unknown> | undefined;
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
	const ymeta = documentsMap(doc).get(id) as Y.Map<unknown> | undefined;
	if (!ymeta) throw new NotFoundError(`Document ${id} not found`);

	doc.transact(() => {
		const resolvedOrder =
			order ??
			computeSiblingOrder(
				listDocuments(doc)
					.filter((d) => d.id !== id)
					.filter((d) => d.parentDocumentId === (parentDocumentId || undefined)),
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

export function updateCollectionTitle(doc: Y.Doc, id: string, title: string): void {
	const ymeta = collectionsMap(doc).get(id) as Y.Map<unknown> | undefined;
	if (!ymeta) throw new NotFoundError(`Collection ${id} not found`);
	ymeta.set('title', title);
}

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

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export function listCollections(doc: Y.Doc): CollectionMeta[] {
	const out: CollectionMeta[] = [];
	collectionsMap(doc).forEach((ymeta, id) => {
		out.push(readCollectionMeta(id, ymeta as Y.Map<unknown>));
	});
	return out;
}

export function getCollection(doc: Y.Doc, id: string): CollectionMeta | undefined {
	const ymeta = collectionsMap(doc).get(id) as Y.Map<unknown> | undefined;
	return ymeta ? readCollectionMeta(id, ymeta) : undefined;
}

function readCollectionMeta(id: string, ymeta: Y.Map<unknown>): CollectionMeta {
	const recordIds = ymeta.get('recordIds') as Y.Array<string>;
	return {
		id,
		title: ymeta.get('title') as string,
		schema: (ymeta.get('schema') as PropertyDefinition[]) ?? [],
		recordIds: recordIds ? recordIds.toArray() : [],
		primaryFieldKey: (ymeta.get('primaryFieldKey') as string | undefined) || undefined
	};
}

export function createCollection(
	doc: Y.Doc,
	input: { id?: string; title: string; schema: PropertyDefinition[] }
): CollectionMeta {
	const id = input.id ?? nanoid();
	doc.transact(() => {
		const ymeta = new Y.Map<unknown>();
		ymeta.set('title', input.title);
		ymeta.set('schema', input.schema);
		ymeta.set('recordIds', new Y.Array<string>());
		collectionsMap(doc).set(id, ymeta);
	});
	return { id, title: input.title, schema: input.schema, recordIds: [] };
}

export function updateCollectionSchema(doc: Y.Doc, id: string, schema: PropertyDefinition[]): void {
	const ymeta = collectionsMap(doc).get(id) as Y.Map<unknown> | undefined;
	if (!ymeta) throw new NotFoundError(`Collection ${id} not found`);
	ymeta.set('schema', schema);
}

// A `relation` value is a list of record IDs with no inherent display string
// of its own (data-model.md's PropertyValue — resolving it to a title would
// mean reaching into other records), so it's the one property type that
// can't stand in for a record's own identity — every other type already
// renders as a single displayable value via PropertyValueCell.
function isEligiblePrimaryFieldType(type: PropertyType): boolean {
	return type !== 'relation';
}

/**
 * The field that represents a record's title/identity — Airtable's "primary
 * field," GitLab's issue title. Resolves the Collection's explicit
 * `primaryFieldKey` when it names an eligible field still in schema, or
 * falls back to the first `text` field in schema order otherwise — the
 * fallback exists so a pre-existing Collection (created before this field
 * existed, or one where the primary field was since deleted/retyped) keeps
 * showing the same title it always implicitly had, without a migration
 * step. The fallback only ever considers `text` fields, not every eligible
 * type — so this returns undefined both when the schema has no eligible
 * field at all, and when it has eligible fields (e.g. a lone `number` or
 * `select` field) but none of type `text`.
 */
export function resolvePrimaryField(
	schema: PropertyDefinition[],
	primaryFieldKey: string | undefined
): PropertyDefinition | undefined {
	if (primaryFieldKey) {
		const explicit = schema.find((p) => p.key === primaryFieldKey);
		if (explicit && isEligiblePrimaryFieldType(explicit.type)) return explicit;
	}
	return schema.find((p) => p.type === 'text');
}

/**
 * Sets (or, with `propertyKey: null`, clears) the Collection's explicit
 * primary field. Clearing reverts to `resolvePrimaryField`'s automatic
 * fallback rather than leaving the Collection with no title field at all.
 */
export function setPrimaryField(
	doc: Y.Doc,
	collectionId: string,
	propertyKey: string | null
): void {
	const ymeta = collectionsMap(doc).get(collectionId) as Y.Map<unknown> | undefined;
	if (!ymeta) throw new NotFoundError(`Collection ${collectionId} not found`);
	if (propertyKey === null) {
		ymeta.delete('primaryFieldKey');
		return;
	}
	const schema = (ymeta.get('schema') as PropertyDefinition[]) ?? [];
	const property = schema.find((p) => p.key === propertyKey);
	if (!property) throw new NotFoundError(`Property ${propertyKey} not found`);
	if (!isEligiblePrimaryFieldType(property.type)) {
		throw new ValidationError(`A ${property.type} field can't be the primary field`);
	}
	ymeta.set('primaryFieldKey', propertyKey);
}

/**
 * Best-effort value conversion for a field type change — used both to preview
 * how many values would be lost (before the user confirms) and to actually
 * migrate values when the change is applied. Returns undefined when there's
 * no lossless-enough conversion, which the caller treats as "clear the
 * value" rather than leaving a value whose `type` no longer matches the
 * field's schema type.
 */
export function coercePropertyValue(
	value: PropertyValue,
	toType: PropertyType
): PropertyValue | undefined {
	if (value.type === toType) return value;
	switch (toType) {
		case 'text':
			if (value.type === 'number') return { type: 'text', value: String(value.value) };
			if (value.type === 'date') return { type: 'text', value: value.value };
			if (value.type === 'checkbox') return { type: 'text', value: value.value ? 'true' : 'false' };
			return undefined;
		case 'number': {
			if (value.type !== 'text' || value.value.trim() === '') return undefined;
			const n = Number(value.value);
			return Number.isFinite(n) ? { type: 'number', value: n } : undefined;
		}
		case 'checkbox': {
			if (value.type !== 'text') return undefined;
			const v = value.value.trim().toLowerCase();
			if (v === 'true') return { type: 'checkbox', value: true };
			if (v === 'false') return { type: 'checkbox', value: false };
			return undefined;
		}
		default:
			return undefined; // date, select, relation: no safe generic coercion
	}
}

/** How many of a Collection's records would lose their value if `propertyKey` were changed to `toType` — surfaced in the field editor's confirmation before the change is applied. */
export function previewCollectionPropertyTypeChange(
	doc: Y.Doc,
	collectionId: string,
	propertyKey: string,
	toType: PropertyType
): { affected: number; total: number } {
	let affected = 0;
	let total = 0;
	for (const record of listRecordsForParent(doc, collectionId)) {
		const value = record.properties?.[propertyKey];
		if (value === undefined) continue;
		total++;
		if (coercePropertyValue(value, toType) === undefined) affected++;
	}
	return { affected, total };
}

/** Renames and/or retypes one field in a Collection's schema, migrating (or clearing, per `coercePropertyValue`) every record's existing value when `patch.type` changes. */
export function updateCollectionProperty(
	doc: Y.Doc,
	collectionId: string,
	propertyKey: string,
	patch: { label?: string; type?: PropertyType }
): void {
	const ymeta = collectionsMap(doc).get(collectionId) as Y.Map<unknown> | undefined;
	if (!ymeta) throw new NotFoundError(`Collection ${collectionId} not found`);
	doc.transact(() => {
		const schema = (ymeta.get('schema') as PropertyDefinition[]) ?? [];
		const index = schema.findIndex((p) => p.key === propertyKey);
		if (index === -1) throw new NotFoundError(`Property ${propertyKey} not found`);
		const current = schema[index];
		const nextType = patch.type ?? current.type;
		const next: PropertyDefinition = {
			...current,
			label: patch.label !== undefined ? patch.label : current.label,
			type: nextType,
			options:
				nextType === 'select' ? (current.type === 'select' ? current.options : []) : undefined
		};
		const nextSchema = [...schema];
		nextSchema[index] = next;
		ymeta.set('schema', nextSchema);

		if (patch.type && patch.type !== current.type) {
			for (const record of listRecordsForParent(doc, collectionId)) {
				const value = record.properties?.[propertyKey];
				if (value === undefined) continue;
				const yrecord = recordsMap(doc).get(record.id) as Y.Map<unknown> | undefined;
				const coerced = coercePropertyValue(value, patch.type);
				if (coerced) yrecord?.set(PROP_PREFIX + propertyKey, coerced);
				else yrecord?.delete(PROP_PREFIX + propertyKey);
			}
			// A retype away from an eligible primary-field type would otherwise
			// leave `primaryFieldKey` pointing at a field that can no longer
			// represent a record's identity (e.g. text -> relation) — clear it so
			// resolvePrimaryField's fallback takes over instead of silently
			// keeping a now-invalid explicit choice.
			if (ymeta.get('primaryFieldKey') === propertyKey && !isEligiblePrimaryFieldType(patch.type)) {
				ymeta.delete('primaryFieldKey');
			}
		}
	});
}

/** Clones a field definition (fresh key, "<label> copy") immediately after the source field, copying every record's existing value under the new key. */
export function duplicateCollectionProperty(
	doc: Y.Doc,
	collectionId: string,
	propertyKey: string
): PropertyDefinition {
	const ymeta = collectionsMap(doc).get(collectionId) as Y.Map<unknown> | undefined;
	if (!ymeta) throw new NotFoundError(`Collection ${collectionId} not found`);
	return doc.transact(() => {
		const schema = (ymeta.get('schema') as PropertyDefinition[]) ?? [];
		const index = schema.findIndex((p) => p.key === propertyKey);
		if (index === -1) throw new NotFoundError(`Property ${propertyKey} not found`);
		const source = schema[index];
		const copy: PropertyDefinition = {
			...source,
			key: nanoid(8),
			label: `${source.label} copy`,
			options: source.options?.map((o) => ({ ...o }))
		};
		const nextSchema = [...schema.slice(0, index + 1), copy, ...schema.slice(index + 1)];
		ymeta.set('schema', nextSchema);

		for (const record of listRecordsForParent(doc, collectionId)) {
			const value = record.properties?.[propertyKey];
			if (value === undefined) continue;
			const yrecord = recordsMap(doc).get(record.id) as Y.Map<unknown> | undefined;
			yrecord?.set(PROP_PREFIX + copy.key, value);
		}

		return copy;
	});
}

/** How many of a Collection's records currently hold a value for `propertyKey` — the "affected records" count shown before a destructive field deletion. */
export function countRecordsWithProperty(
	doc: Y.Doc,
	collectionId: string,
	propertyKey: string
): number {
	return listRecordsForParent(doc, collectionId).filter(
		(r) => r.properties?.[propertyKey] !== undefined
	).length;
}

// Strips a deleted field out of any collection_view block's persisted
// viewConfig that still references it (filters/visibleProperties/groupBy/
// sort), across every Document — a stale propertyKey there would otherwise
// silently break that embed's filtering/grouping/sort the next time it
// renders. Manual per-column Board order isn't touched: it's session-local
// state, never persisted to viewConfig in the first place (collection-views.md §6).
function repairEmbeddedViewsAfterPropertyRemoval(
	doc: Y.Doc,
	collectionId: string,
	propertyKey: string
): void {
	recordsMap(doc).forEach((yrecord) => {
		if (yrecord.get('blockType') !== 'collection_view') return;
		if (yrecord.get('referencedRecordId') !== collectionId) return;
		const config = yrecord.get('viewConfig') as EmbeddedViewConfig | undefined;
		if (!config) return;

		const next: EmbeddedViewConfig = { ...config };
		let changed = false;
		if (next.filters?.some((f) => f.propertyKey === propertyKey)) {
			next.filters = next.filters.filter((f) => f.propertyKey !== propertyKey);
			changed = true;
		}
		if (next.visibleProperties?.includes(propertyKey)) {
			next.visibleProperties = next.visibleProperties.filter((k) => k !== propertyKey);
			changed = true;
		}
		if (next.groupBy === propertyKey) {
			next.groupBy = undefined;
			changed = true;
		}
		if (next.sort?.propertyKey === propertyKey) {
			next.sort = { mode: 'manual' };
			changed = true;
		}
		if (changed) yrecord.set('viewConfig', next);
	});
}

/**
 * Removes a field from a Collection's schema, strips its value off every
 * record, and repairs any embedded view's config that referenced it — the
 * "explicitly destructive" delete path §93 of the field manager asks for.
 *
 * `documentsDoc` — the doc holding the Document blocks (`collection_view`
 * embeds) whose viewConfig needs repairing — defaults to `doc` for callers
 * that keep everything in one Y.Doc (every pure unit test, and any future
 * caller with no shard split), but since #120 sharded Collections while
 * Documents stayed on the shared doc, a real caller must pass that doc
 * explicitly or the repair silently scans the wrong (empty) doc.
 */
export function deleteCollectionProperty(
	doc: Y.Doc,
	collectionId: string,
	propertyKey: string,
	documentsDoc: Y.Doc = doc
): void {
	const ymeta = collectionsMap(doc).get(collectionId) as Y.Map<unknown> | undefined;
	if (!ymeta) throw new NotFoundError(`Collection ${collectionId} not found`);
	doc.transact(() => {
		const schema = (ymeta.get('schema') as PropertyDefinition[]) ?? [];
		ymeta.set(
			'schema',
			schema.filter((p) => p.key !== propertyKey)
		);

		for (const record of listRecordsForParent(doc, collectionId)) {
			if (record.properties?.[propertyKey] === undefined) continue;
			const yrecord = recordsMap(doc).get(record.id) as Y.Map<unknown> | undefined;
			yrecord?.delete(PROP_PREFIX + propertyKey);
		}

		if (ymeta.get('primaryFieldKey') === propertyKey) {
			ymeta.delete('primaryFieldKey');
		}
	});
	// Outside the transact above: documentsDoc may be a different Y.Doc than
	// doc (see param doc), and Yjs transactions don't span docs anyway.
	repairEmbeddedViewsAfterPropertyRemoval(documentsDoc, collectionId, propertyKey);
}

// ---------------------------------------------------------------------------
// Select field option lifecycle (issue #94) — add/rename/recolor/reorder/
// delete one option within a `select` field's `options` array. Distinct from
// updateCollectionProperty/deleteCollectionProperty above, which operate on
// the field itself; these operate one level down, inside `options`.
// ---------------------------------------------------------------------------

function getSelectPropertyForMutation(
	schema: PropertyDefinition[],
	propertyKey: string
): {
	index: number;
	property: PropertyDefinition;
	options: { id: string; label: string; color?: string }[];
} {
	const index = schema.findIndex((p) => p.key === propertyKey);
	if (index === -1) throw new NotFoundError(`Property ${propertyKey} not found`);
	const property = schema[index];
	if (property.type !== 'select') {
		throw new ValidationError(`Property ${propertyKey} is not a select field`);
	}
	return { index, property, options: property.options ?? [] };
}

function assertUniqueOptionLabel(
	options: { id: string; label: string }[],
	label: string,
	excludeOptionId?: string
): string {
	const trimmed = label.trim();
	if (!trimmed) throw new ValidationError('Option label cannot be blank');
	const collides = options.some(
		(o) => o.id !== excludeOptionId && o.label.trim().toLowerCase() === trimmed.toLowerCase()
	);
	if (collides) throw new ValidationError(`An option named "${trimmed}" already exists`);
	return trimmed;
}

/** Appends a new option to a select field, auto-assigning the next palette color unless one is given. Rejects a blank or already-used (case-insensitive) label. */
export function addSelectOption(
	doc: Y.Doc,
	collectionId: string,
	propertyKey: string,
	label: string,
	color?: string
): { id: string; label: string; color?: string } {
	const ymeta = collectionsMap(doc).get(collectionId) as Y.Map<unknown> | undefined;
	if (!ymeta) throw new NotFoundError(`Collection ${collectionId} not found`);
	return doc.transact(() => {
		const schema = (ymeta.get('schema') as PropertyDefinition[]) ?? [];
		const { index, property, options } = getSelectPropertyForMutation(schema, propertyKey);
		const trimmed = assertUniqueOptionLabel(options, label);
		const option = {
			id: nanoid(6),
			label: trimmed,
			color: color ?? nextSelectOptionColor(options.length)
		};
		const nextSchema = [...schema];
		nextSchema[index] = { ...property, options: [...options, option] };
		ymeta.set('schema', nextSchema);
		return option;
	});
}

/** Renames and/or recolors one existing option. Rejects a blank or already-used (case-insensitive) label. */
export function updateSelectOption(
	doc: Y.Doc,
	collectionId: string,
	propertyKey: string,
	optionId: string,
	patch: { label?: string; color?: string }
): void {
	const ymeta = collectionsMap(doc).get(collectionId) as Y.Map<unknown> | undefined;
	if (!ymeta) throw new NotFoundError(`Collection ${collectionId} not found`);
	doc.transact(() => {
		const schema = (ymeta.get('schema') as PropertyDefinition[]) ?? [];
		const { index, property, options } = getSelectPropertyForMutation(schema, propertyKey);
		const optIndex = options.findIndex((o) => o.id === optionId);
		if (optIndex === -1) throw new NotFoundError(`Option ${optionId} not found`);
		const current = options[optIndex];
		const nextLabel =
			patch.label !== undefined
				? assertUniqueOptionLabel(options, patch.label, optionId)
				: current.label;
		const nextOptions = [...options];
		nextOptions[optIndex] = {
			...current,
			label: nextLabel,
			color: patch.color !== undefined ? patch.color : current.color
		};
		const nextSchema = [...schema];
		nextSchema[index] = { ...property, options: nextOptions };
		ymeta.set('schema', nextSchema);
	});
}

/** Moves one option to `toIndex` within its field's options array (clamped to bounds) — the single reorder primitive behind both the up/down buttons and drag reordering in the field editor. Board column order, the cell dropdown, and filter-value order all derive from this same array, so this is also what reorders those. */
export function moveSelectOption(
	doc: Y.Doc,
	collectionId: string,
	propertyKey: string,
	optionId: string,
	toIndex: number
): void {
	const ymeta = collectionsMap(doc).get(collectionId) as Y.Map<unknown> | undefined;
	if (!ymeta) throw new NotFoundError(`Collection ${collectionId} not found`);
	doc.transact(() => {
		const schema = (ymeta.get('schema') as PropertyDefinition[]) ?? [];
		const { index, property, options } = getSelectPropertyForMutation(schema, propertyKey);
		const fromIndex = options.findIndex((o) => o.id === optionId);
		if (fromIndex === -1) throw new NotFoundError(`Option ${optionId} not found`);
		const clampedTo = Math.max(0, Math.min(toIndex, options.length - 1));
		if (clampedTo === fromIndex) return;
		const nextOptions = [...options];
		const [moved] = nextOptions.splice(fromIndex, 1);
		nextOptions.splice(clampedTo, 0, moved);
		const nextSchema = [...schema];
		nextSchema[index] = { ...property, options: nextOptions };
		ymeta.set('schema', nextSchema);
	});
}

/** How many of a Collection's records currently hold `optionId` as their value for `propertyKey` — the "affected records" count shown before a destructive option deletion. */
export function countRecordsWithSelectOption(
	doc: Y.Doc,
	collectionId: string,
	propertyKey: string,
	optionId: string
): number {
	return listRecordsForParent(doc, collectionId).filter((r) => {
		const value = r.properties?.[propertyKey];
		return value?.type === 'select' && value.value === optionId;
	}).length;
}

// Strips a deleted option out of any collection_view block's persisted
// viewConfig.filters that still reference it by value — a stale option id
// there would otherwise silently stop matching anything the next time that
// embed's filter is applied. Unlike repairEmbeddedViewsAfterPropertyRemoval,
// this never touches groupBy/sort/visibleProperties: those name the field
// itself, which still exists after only one of its options is removed.
function repairEmbeddedViewsAfterOptionRemoval(
	doc: Y.Doc,
	collectionId: string,
	propertyKey: string,
	optionId: string
): void {
	recordsMap(doc).forEach((yrecord) => {
		if (yrecord.get('blockType') !== 'collection_view') return;
		if (yrecord.get('referencedRecordId') !== collectionId) return;
		const config = yrecord.get('viewConfig') as EmbeddedViewConfig | undefined;
		if (!config?.filters?.length) return;
		const nextFilters = config.filters.filter(
			(f) => !(f.propertyKey === propertyKey && f.value === optionId)
		);
		if (nextFilters.length !== config.filters.length) {
			yrecord.set('viewConfig', { ...config, filters: nextFilters });
		}
	});
}

/**
 * Removes one option from a select field, clears the value on every record
 * currently set to it (the documented "unassigned" state — the same
 * empty/no-value state Board's catch-all column and the cell dropdown's
 * blank entry already represent), and strips any embedded view filter that
 * referenced it. The field itself and its other options are untouched.
 *
 * `documentsDoc` — see deleteCollectionProperty's doc comment; same reason,
 * same default.
 */
export function deleteSelectOption(
	doc: Y.Doc,
	collectionId: string,
	propertyKey: string,
	optionId: string,
	documentsDoc: Y.Doc = doc
): void {
	const ymeta = collectionsMap(doc).get(collectionId) as Y.Map<unknown> | undefined;
	if (!ymeta) throw new NotFoundError(`Collection ${collectionId} not found`);
	let removed = false;
	doc.transact(() => {
		const schema = (ymeta.get('schema') as PropertyDefinition[]) ?? [];
		const { index, property, options } = getSelectPropertyForMutation(schema, propertyKey);
		const nextOptions = options.filter((o) => o.id !== optionId);
		if (nextOptions.length === options.length) return;
		removed = true;
		const nextSchema = [...schema];
		nextSchema[index] = { ...property, options: nextOptions };
		ymeta.set('schema', nextSchema);

		for (const record of listRecordsForParent(doc, collectionId)) {
			const value = record.properties?.[propertyKey];
			if (value?.type !== 'select' || value.value !== optionId) continue;
			const yrecord = recordsMap(doc).get(record.id) as Y.Map<unknown> | undefined;
			yrecord?.delete(PROP_PREFIX + propertyKey);
		}
	});
	if (removed)
		repairEmbeddedViewsAfterOptionRemoval(documentsDoc, collectionId, propertyKey, optionId);
}

export function deleteCollection(doc: Y.Doc, id: string): void {
	doc.transact(() => {
		const meta = getCollection(doc, id);
		if (!meta) return;
		for (const recordId of meta.recordIds) {
			recordsMap(doc).delete(recordId);
		}
		collectionsMap(doc).delete(id);
	});
}

// ---------------------------------------------------------------------------
// Records (blocks and rows — one addressing scheme)
// ---------------------------------------------------------------------------

function parentKindOf(doc: Y.Doc, parentId: string): ParentKind | undefined {
	if (documentsMap(doc).has(parentId)) return 'document';
	if (collectionsMap(doc).has(parentId)) return 'collection';
	return undefined;
}

function parentRecordIds(doc: Y.Doc, parentId: string, kind: ParentKind): Y.Array<string> {
	const map = kind === 'document' ? documentsMap(doc) : collectionsMap(doc);
	const ymeta = map.get(parentId) as Y.Map<unknown>;
	return ymeta.get('recordIds') as Y.Array<string>;
}

/**
 * Direct access to a block-record's Y.Text, for the UI's live keystroke
 * binding (§8) — MCP writes go through updateRecordContent's whole-block
 * replace instead, since they arrive as one finished write, not keystrokes.
 */
export function getRecordYText(doc: Y.Doc, id: string): Y.Text | undefined {
	const yrecord = recordsMap(doc).get(id) as Y.Map<unknown> | undefined;
	return yrecord?.get('content') as Y.Text | undefined;
}

export function touchRecordEditor(doc: Y.Doc, id: string, actor: ActorId): void {
	const yrecord = recordsMap(doc).get(id) as Y.Map<unknown> | undefined;
	if (!yrecord) return;
	yrecord.set('lastEditedBy', actor);
	yrecord.set('lastEditedAt', Date.now());
}

export function getRecord(doc: Y.Doc, id: string): WorkspaceRecord | undefined {
	const yrecord = recordsMap(doc).get(id) as Y.Map<unknown> | undefined;
	return yrecord ? readRecord(yrecord) : undefined;
}

function readRecord(yrecord: Y.Map<unknown>): WorkspaceRecord {
	const content = yrecord.get('content') as Y.Text | undefined;
	const properties: Record<string, PropertyValue> = {};
	yrecord.forEach((value, key) => {
		if (key.startsWith(PROP_PREFIX)) {
			properties[key.slice(PROP_PREFIX.length)] = value as PropertyValue;
		}
	});
	const hasProps = Object.keys(properties).length > 0 || yrecord.get('isCollectionRow');

	return {
		id: yrecord.get('id') as string,
		parentId: yrecord.get('parentId') as string,
		order: yrecord.get('order') as string,
		blockType: yrecord.get('blockType') as BlockType | undefined,
		content: content ? yTextToRichText(content) : undefined,
		properties: hasProps ? properties : undefined,
		checked: yrecord.get('checked') as boolean | undefined,
		collapsed: yrecord.get('collapsed') as boolean | undefined,
		referencedRecordId: yrecord.get('referencedRecordId') as string | undefined,
		viewConfig: yrecord.get('viewConfig') as EmbeddedViewConfig | undefined,
		createdBy: yrecord.get('createdBy') as ActorId,
		createdAt: yrecord.get('createdAt') as number,
		lastEditedBy: yrecord.get('lastEditedBy') as ActorId,
		lastEditedAt: yrecord.get('lastEditedAt') as number
	};
}

export interface CreateRecordInput {
	id?: string;
	parentId: string;
	afterRecordId?: string;
	blockType?: BlockType; // set when parent is a Document
	properties?: Record<string, PropertyValue>; // set when parent is a Collection
	checked?: boolean;
	collapsed?: boolean;
	referencedRecordId?: string;
	viewConfig?: EmbeddedViewConfig; // for collection_view blocks
}

export function createRecord(
	doc: Y.Doc,
	input: CreateRecordInput,
	actor: ActorId
): WorkspaceRecord {
	const kind = parentKindOf(doc, input.parentId);
	if (!kind) throw new NotFoundError(`Parent ${input.parentId} not found`);

	const id = input.id ?? nanoid();
	const now = Date.now();

	return doc.transact(() => {
		const siblingIds = parentRecordIds(doc, input.parentId, kind);
		const insertAt = input.afterRecordId
			? siblingIds.toArray().indexOf(input.afterRecordId) + 1
			: siblingIds.length;
		const before = insertAt > 0 ? recordOrder(doc, siblingIds.get(insertAt - 1)) : null;
		const after = insertAt < siblingIds.length ? recordOrder(doc, siblingIds.get(insertAt)) : null;
		const order = generateKeyBetween(before, after);

		const yrecord = new Y.Map<unknown>();
		yrecord.set('id', id);
		yrecord.set('parentId', input.parentId);
		yrecord.set('order', order);
		yrecord.set('createdBy', actor);
		yrecord.set('createdAt', now);
		yrecord.set('lastEditedBy', actor);
		yrecord.set('lastEditedAt', now);

		if (kind === 'document') {
			yrecord.set('blockType', input.blockType ?? 'paragraph');
			yrecord.set('content', new Y.Text());
			if (input.checked !== undefined) yrecord.set('checked', input.checked);
			if (input.collapsed !== undefined) yrecord.set('collapsed', input.collapsed);
			if (input.referencedRecordId) yrecord.set('referencedRecordId', input.referencedRecordId);
			if (input.viewConfig) yrecord.set('viewConfig', input.viewConfig);
		} else {
			yrecord.set('isCollectionRow', true);
			for (const [key, value] of Object.entries(input.properties ?? {})) {
				yrecord.set(PROP_PREFIX + key, value);
			}
		}

		recordsMap(doc).set(id, yrecord);
		siblingIds.insert(insertAt, [id]);

		return readRecord(yrecord);
	});
}

function recordOrder(doc: Y.Doc, id: string): string | null {
	const yrecord = recordsMap(doc).get(id) as Y.Map<unknown> | undefined;
	return (yrecord?.get('order') as string) ?? null;
}

export function updateRecordContent(
	doc: Y.Doc,
	id: string,
	content: RichText,
	actor: ActorId
): WorkspaceRecord {
	const yrecord = recordsMap(doc).get(id) as Y.Map<unknown> | undefined;
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);
	const ytext = yrecord.get('content') as Y.Text | undefined;
	if (!ytext) throw new Error(`Record ${id} has no block content (is it a Collection row?)`);

	doc.transact(() => {
		applyRichTextToYText(ytext, content);
		yrecord.set('lastEditedBy', actor);
		yrecord.set('lastEditedAt', Date.now());
	});
	return readRecord(yrecord);
}

export function updateRecordProperties(
	doc: Y.Doc,
	id: string,
	properties: Record<string, PropertyValue>,
	actor: ActorId
): WorkspaceRecord {
	const yrecord = recordsMap(doc).get(id) as Y.Map<unknown> | undefined;
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);

	doc.transact(() => {
		for (const [key, value] of Object.entries(properties)) {
			yrecord.set(PROP_PREFIX + key, value);
		}
		yrecord.set('lastEditedBy', actor);
		yrecord.set('lastEditedAt', Date.now());
	});
	return readRecord(yrecord);
}

export function setBlockType(doc: Y.Doc, id: string, blockType: BlockType, actor: ActorId): void {
	const yrecord = recordsMap(doc).get(id) as Y.Map<unknown> | undefined;
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);
	doc.transact(() => {
		yrecord.set('blockType', blockType);
		yrecord.set('lastEditedBy', actor);
		yrecord.set('lastEditedAt', Date.now());
	});
}

export function setRecordChecked(doc: Y.Doc, id: string, checked: boolean, actor: ActorId): void {
	const yrecord = recordsMap(doc).get(id) as Y.Map<unknown> | undefined;
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);
	doc.transact(() => {
		yrecord.set('checked', checked);
		yrecord.set('lastEditedBy', actor);
		yrecord.set('lastEditedAt', Date.now());
	});
}

export function setRecordCollapsed(
	doc: Y.Doc,
	id: string,
	collapsed: boolean,
	actor: ActorId
): void {
	const yrecord = recordsMap(doc).get(id) as Y.Map<unknown> | undefined;
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);
	doc.transact(() => {
		yrecord.set('collapsed', collapsed);
		yrecord.set('lastEditedBy', actor);
		yrecord.set('lastEditedAt', Date.now());
	});
}

export function setRecordReferencedId(
	doc: Y.Doc,
	id: string,
	referencedRecordId: string,
	actor: ActorId
): void {
	const yrecord = recordsMap(doc).get(id) as Y.Map<unknown> | undefined;
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);
	doc.transact(() => {
		yrecord.set('referencedRecordId', referencedRecordId);
		yrecord.set('lastEditedBy', actor);
		yrecord.set('lastEditedAt', Date.now());
	});
}

// A collection_view block's view type + filters/sort/visible-properties/
// grouping-property choice — whole-value LWW, same pattern as
// setRecordReferencedId. One person is expected to be editing a given
// embed's config at a time, so field-level merge granularity (splitting
// into prop:-style sub-keys, like Collection row properties do) isn't
// needed here.
export function setRecordViewConfig(
	doc: Y.Doc,
	id: string,
	viewConfig: EmbeddedViewConfig,
	actor: ActorId
): void {
	const yrecord = recordsMap(doc).get(id) as Y.Map<unknown> | undefined;
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);
	doc.transact(() => {
		yrecord.set('viewConfig', viewConfig);
		yrecord.set('lastEditedBy', actor);
		yrecord.set('lastEditedAt', Date.now());
	});
}

export function deleteRecord(doc: Y.Doc, id: string): void {
	doc.transact(() => {
		const yrecord = recordsMap(doc).get(id) as Y.Map<unknown> | undefined;
		if (!yrecord) return;
		const parentId = yrecord.get('parentId') as string;
		const kind = parentKindOf(doc, parentId);
		if (kind) {
			const siblingIds = parentRecordIds(doc, parentId, kind);
			const idx = siblingIds.toArray().indexOf(id);
			if (idx !== -1) siblingIds.delete(idx, 1);
		}
		recordsMap(doc).delete(id);
	});
}

export function listRecordsForParent(doc: Y.Doc, parentId: string): WorkspaceRecord[] {
	const kind = parentKindOf(doc, parentId);
	if (!kind) return [];
	const ids = parentRecordIds(doc, parentId, kind).toArray();
	return ids.map((id) => getRecord(doc, id)).filter((r): r is WorkspaceRecord => r !== undefined);
}
