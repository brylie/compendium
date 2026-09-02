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
import { type TypedYMap, typedYMap, typedYMapRegistry } from './yjs-typed';

const DOCUMENTS = 'documents';
const COLLECTIONS = 'collections';
const RECORDS = 'records';

// Properties are stored as individual `prop:<key>` entries on the record's
// Y.Map, rather than one JSON blob under a single key, so two humans editing
// different properties of the same row concurrently each merge (Y.Map's
// per-key LWW) instead of one clobbering the other's unrelated edit.
const PROP_PREFIX = 'prop:';

// The known field shape of each top-level Y.Map's entries — the single
// source of truth TypedYMap uses to give every get/set on these maps a real
// type instead of `unknown` (issue #174). `recordIds` on Document/Collection
// carries the Y.Array itself (not its snapshot), same as the raw Yjs shape
// always has.
interface DocumentYShape {
	id: string;
	title: string;
	parentDocumentId?: string;
	order: string;
	recordIds: Y.Array<string>;
}

interface CollectionYShape {
	title: string;
	schema: PropertyDefinition[];
	recordIds: Y.Array<string>;
	primaryFieldKey?: string;
}

// Collection-row properties aren't part of this shape: they live under
// dynamic `prop:<key>` entries (see PROP_PREFIX above), read/written via
// getPropertyValue/setPropertyValue/deletePropertyValue below rather than
// TypedYMap's fixed-key get/set.
interface RecordYShape {
	id: string;
	parentId: string;
	order: string;
	blockType?: BlockType;
	content?: Y.Text;
	isCollectionRow?: boolean;
	checked?: boolean;
	collapsed?: boolean;
	referencedRecordId?: string;
	viewConfig?: EmbeddedViewConfig;
	createdBy: ActorId;
	createdAt: number;
	lastEditedBy: ActorId;
	lastEditedAt: number;
}

function documentsMap(doc: Y.Doc) {
	return typedYMapRegistry<DocumentYShape>(doc.getMap(DOCUMENTS));
}
function collectionsMap(doc: Y.Doc) {
	return typedYMapRegistry<CollectionYShape>(doc.getMap(COLLECTIONS));
}
function recordsMap(doc: Y.Doc) {
	return typedYMapRegistry<RecordYShape>(doc.getMap(RECORDS));
}

function setPropertyValue(
	yrecord: TypedYMap<RecordYShape>,
	key: string,
	value: PropertyValue
): void {
	yrecord.raw.set(PROP_PREFIX + key, value);
}
function deletePropertyValue(yrecord: TypedYMap<RecordYShape>, key: string): void {
	yrecord.raw.delete(PROP_PREFIX + key);
}

/** Thrown when a requested Document, Collection, record, property, or select option doesn't exist. */
export class NotFoundError extends Error {}
/** Thrown when an actor attempts a mutation they aren't permitted to make. */
export class PermissionError extends Error {}
/** Thrown when an input value fails a domain rule (e.g. a blank/duplicate select-option label, a field type that can't be the primary field). */
export class ValidationError extends Error {}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

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
	const parentDocumentId = input.parentDocumentId ?? undefined;

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
		const resolvedOrder =
			order ??
			computeSiblingOrder(
				listDocuments(doc)
					.filter((d) => d.id !== id)
					.filter((d) => d.parentDocumentId === (parentDocumentId ?? undefined)),
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

/** Renames a Collection. Throws NotFoundError if it doesn't exist. */
export function updateCollectionTitle(doc: Y.Doc, id: string, title: string): void {
	const ymeta = collectionsMap(doc).get(id);
	if (!ymeta) throw new NotFoundError(`Collection ${id} not found`);
	ymeta.set('title', title);
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

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

/** All Collections in the workspace. */
export function listCollections(doc: Y.Doc): CollectionMeta[] {
	const out: CollectionMeta[] = [];
	collectionsMap(doc).forEach((ymeta, id) => {
		out.push(readCollectionMeta(id, ymeta));
	});
	return out;
}

/** Looks up one Collection's metadata by id, or undefined if it doesn't exist. */
export function getCollection(doc: Y.Doc, id: string): CollectionMeta | undefined {
	const ymeta = collectionsMap(doc).get(id);
	return ymeta ? readCollectionMeta(id, ymeta) : undefined;
}

function readCollectionMeta(id: string, ymeta: TypedYMap<CollectionYShape>): CollectionMeta {
	const recordIds = ymeta.get('recordIds');
	return {
		id,
		title: ymeta.get('title')!,
		schema: ymeta.get('schema') ?? [],
		recordIds: recordIds ? recordIds.toArray() : [],
		primaryFieldKey: ymeta.get('primaryFieldKey') ?? undefined
	};
}

/** Creates a new Collection with the given schema and no records. */
export function createCollection(
	doc: Y.Doc,
	input: { id?: string; title: string; schema: PropertyDefinition[] }
): CollectionMeta {
	const id = input.id ?? nanoid();
	doc.transact(() => {
		const ymeta = typedYMap<CollectionYShape>(new Y.Map<unknown>());
		ymeta.set('title', input.title);
		ymeta.set('schema', input.schema);
		ymeta.set('recordIds', new Y.Array<string>());
		collectionsMap(doc).set(id, ymeta.raw);
	});
	return { id, title: input.title, schema: input.schema, recordIds: [] };
}

/** Replaces a Collection's entire schema wholesale, with no per-field migration of existing record values — use updateCollectionProperty for a single-field rename/retype that needs that. */
export function updateCollectionSchema(doc: Y.Doc, id: string, schema: PropertyDefinition[]): void {
	const ymeta = collectionsMap(doc).get(id);
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
	const ymeta = collectionsMap(doc).get(collectionId);
	if (!ymeta) throw new NotFoundError(`Collection ${collectionId} not found`);
	if (propertyKey === null) {
		ymeta.delete('primaryFieldKey');
		return;
	}
	const schema = ymeta.get('schema') ?? [];
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
function coerceToText(value: PropertyValue): PropertyValue | undefined {
	if (value.type === 'number') return { type: 'text', value: String(value.value) };
	if (value.type === 'date') return { type: 'text', value: value.value };
	if (value.type === 'checkbox') return { type: 'text', value: value.value ? 'true' : 'false' };
	return undefined;
}

function coerceToNumber(value: PropertyValue): PropertyValue | undefined {
	if (value.type !== 'text' || value.value.trim() === '') return undefined;
	const n = Number(value.value);
	return Number.isFinite(n) ? { type: 'number', value: n } : undefined;
}

function coerceToCheckbox(value: PropertyValue): PropertyValue | undefined {
	if (value.type !== 'text') return undefined;
	const v = value.value.trim().toLowerCase();
	if (v === 'true') return { type: 'checkbox', value: true };
	if (v === 'false') return { type: 'checkbox', value: false };
	return undefined;
}

/** Best-effort conversion of a property value to a new type (e.g. number to text); returns undefined when there's no lossless-enough conversion, signaling the caller to clear the value instead. */
export function coercePropertyValue(
	value: PropertyValue,
	toType: PropertyType
): PropertyValue | undefined {
	if (value.type === toType) return value;
	switch (toType) {
		case 'text':
			return coerceToText(value);
		case 'number':
			return coerceToNumber(value);
		case 'checkbox':
			return coerceToCheckbox(value);
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

// Coerces (or clears) every record's existing value for propertyKey to
// match a real type change, and clears a stale primaryFieldKey pointing at
// a field that can no longer represent a record's identity (e.g. text ->
// relation) — resolvePrimaryField's fallback takes over instead of silently
// keeping a now-invalid explicit choice. Only called when patch.type is set
// and actually differs from the field's current type.
function migrateRecordsForPropertyRetype(
	doc: Y.Doc,
	collectionId: string,
	ymeta: TypedYMap<CollectionYShape>,
	propertyKey: string,
	toType: PropertyType
): void {
	for (const record of listRecordsForParent(doc, collectionId)) {
		const value = record.properties?.[propertyKey];
		if (value === undefined) continue;
		const yrecord = recordsMap(doc).get(record.id);
		const coerced = coercePropertyValue(value, toType);
		if (!yrecord) continue;
		if (coerced) setPropertyValue(yrecord, propertyKey, coerced);
		else deletePropertyValue(yrecord, propertyKey);
	}
	if (ymeta.get('primaryFieldKey') === propertyKey && !isEligiblePrimaryFieldType(toType)) {
		ymeta.delete('primaryFieldKey');
	}
}

/** Renames and/or retypes one field in a Collection's schema, migrating (or clearing, per `coercePropertyValue`) every record's existing value when `patch.type` changes. */
export function updateCollectionProperty(
	doc: Y.Doc,
	collectionId: string,
	propertyKey: string,
	patch: { label?: string; type?: PropertyType }
): void {
	const ymeta = collectionsMap(doc).get(collectionId);
	if (!ymeta) throw new NotFoundError(`Collection ${collectionId} not found`);
	doc.transact(() => {
		const schema = ymeta.get('schema') ?? [];
		const index = schema.findIndex((p) => p.key === propertyKey);
		if (index === -1) throw new NotFoundError(`Property ${propertyKey} not found`);
		const current = schema[index];
		const nextType = patch.type ?? current.type;
		// Retyping into 'select' keeps existing options if it was already a
		// 'select' (options stay meaningful), otherwise starts empty; retyping
		// away from 'select' drops options entirely (not meaningful for any
		// other type).
		let nextOptions: PropertyDefinition['options'];
		if (nextType === 'select') {
			nextOptions = current.type === 'select' ? current.options : [];
		}
		const next: PropertyDefinition = {
			...current,
			label: patch.label ?? current.label,
			type: nextType,
			options: nextOptions
		};
		const nextSchema = [...schema];
		nextSchema[index] = next;
		ymeta.set('schema', nextSchema);

		if (patch.type && patch.type !== current.type) {
			migrateRecordsForPropertyRetype(doc, collectionId, ymeta, propertyKey, patch.type);
		}
	});
}

/** Clones a field definition (fresh key, "<label> copy") immediately after the source field, copying every record's existing value under the new key. */
export function duplicateCollectionProperty(
	doc: Y.Doc,
	collectionId: string,
	propertyKey: string
): PropertyDefinition {
	const ymeta = collectionsMap(doc).get(collectionId);
	if (!ymeta) throw new NotFoundError(`Collection ${collectionId} not found`);
	return doc.transact(() => {
		const schema = ymeta.get('schema') ?? [];
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
			const yrecord = recordsMap(doc).get(record.id);
			if (yrecord) setPropertyValue(yrecord, copy.key, value);
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
		const config = yrecord.get('viewConfig');
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
	const ymeta = collectionsMap(doc).get(collectionId);
	if (!ymeta) throw new NotFoundError(`Collection ${collectionId} not found`);
	doc.transact(() => {
		const schema = ymeta.get('schema') ?? [];
		ymeta.set(
			'schema',
			schema.filter((p) => p.key !== propertyKey)
		);

		for (const record of listRecordsForParent(doc, collectionId)) {
			if (record.properties?.[propertyKey] === undefined) continue;
			const yrecord = recordsMap(doc).get(record.id);
			if (yrecord) deletePropertyValue(yrecord, propertyKey);
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
	const ymeta = collectionsMap(doc).get(collectionId);
	if (!ymeta) throw new NotFoundError(`Collection ${collectionId} not found`);
	return doc.transact(() => {
		const schema = ymeta.get('schema') ?? [];
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
	const ymeta = collectionsMap(doc).get(collectionId);
	if (!ymeta) throw new NotFoundError(`Collection ${collectionId} not found`);
	doc.transact(() => {
		const schema = ymeta.get('schema') ?? [];
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
			color: patch.color ?? current.color
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
	const ymeta = collectionsMap(doc).get(collectionId);
	if (!ymeta) throw new NotFoundError(`Collection ${collectionId} not found`);
	doc.transact(() => {
		const schema = ymeta.get('schema') ?? [];
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
		const config = yrecord.get('viewConfig');
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
	const ymeta = collectionsMap(doc).get(collectionId);
	if (!ymeta) throw new NotFoundError(`Collection ${collectionId} not found`);
	let removed = false;
	doc.transact(() => {
		const schema = ymeta.get('schema') ?? [];
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
			const yrecord = recordsMap(doc).get(record.id);
			if (yrecord) deletePropertyValue(yrecord, propertyKey);
		}
	});
	if (removed)
		repairEmbeddedViewsAfterOptionRemoval(documentsDoc, collectionId, propertyKey, optionId);
}

/** Deletes a Collection and all of its records. */
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
	if (kind === 'document') {
		return documentsMap(doc).get(parentId)!.get('recordIds')!;
	}
	return collectionsMap(doc).get(parentId)!.get('recordIds')!;
}

/**
 * Direct access to a block-record's Y.Text, for the UI's live keystroke
 * binding (§8) — MCP writes go through updateRecordContent's whole-block
 * replace instead, since they arrive as one finished write, not keystrokes.
 */
export function getRecordYText(doc: Y.Doc, id: string): Y.Text | undefined {
	return recordsMap(doc).get(id)?.get('content');
}

/** Stamps lastEditedBy/lastEditedAt without touching content — for the UI's live keystroke binding, which writes straight to the record's Y.Text (via getRecordYText) and so needs attribution updated separately. */
export function touchRecordEditor(doc: Y.Doc, id: string, actor: ActorId): void {
	const yrecord = recordsMap(doc).get(id);
	if (!yrecord) return;
	doc.transact(() => {
		yrecord.set('lastEditedBy', actor);
		yrecord.set('lastEditedAt', Date.now());
	});
}

/** Looks up one record (block or Collection row) by id, or undefined if it doesn't exist. */
export function getRecord(doc: Y.Doc, id: string): WorkspaceRecord | undefined {
	const yrecord = recordsMap(doc).get(id);
	return yrecord ? readRecord(yrecord) : undefined;
}

function readRecord(yrecord: TypedYMap<RecordYShape>): WorkspaceRecord {
	const content = yrecord.get('content');
	const properties: Record<string, PropertyValue> = {};
	yrecord.raw.forEach((value, key) => {
		if (key.startsWith(PROP_PREFIX)) {
			properties[key.slice(PROP_PREFIX.length)] = value as PropertyValue;
		}
	});
	const hasProps = Object.keys(properties).length > 0 || yrecord.get('isCollectionRow');

	return {
		id: yrecord.get('id')!,
		parentId: yrecord.get('parentId')!,
		order: yrecord.get('order')!,
		blockType: yrecord.get('blockType'),
		content: content ? yTextToRichText(content) : undefined,
		properties: hasProps ? properties : undefined,
		checked: yrecord.get('checked'),
		collapsed: yrecord.get('collapsed'),
		referencedRecordId: yrecord.get('referencedRecordId'),
		viewConfig: yrecord.get('viewConfig'),
		createdBy: yrecord.get('createdBy')!,
		createdAt: yrecord.get('createdAt')!,
		lastEditedBy: yrecord.get('lastEditedBy')!,
		lastEditedAt: yrecord.get('lastEditedAt')!
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

/** Creates a new record (a block if the parent is a Document, a row if the parent is a Collection) and inserts it into the parent's sibling order via a fresh fractional-index `order`. */
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

		const yrecord = typedYMap<RecordYShape>(new Y.Map<unknown>());
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
				setPropertyValue(yrecord, key, value);
			}
		}

		recordsMap(doc).set(id, yrecord.raw);
		siblingIds.insert(insertAt, [id]);

		return readRecord(yrecord);
	});
}

function recordOrder(doc: Y.Doc, id: string): string | null {
	return recordsMap(doc).get(id)?.get('order') ?? null;
}

/** Replaces a block record's rich-text content wholesale — for a single finished write (e.g. from MCP), as opposed to the UI's live keystroke binding which writes to the Y.Text directly. Throws if the record has no block content (i.e. it's a Collection row). */
export function updateRecordContent(
	doc: Y.Doc,
	id: string,
	content: RichText,
	actor: ActorId
): WorkspaceRecord {
	const yrecord = recordsMap(doc).get(id);
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);
	const ytext = yrecord.get('content');
	if (!ytext) throw new Error(`Record ${id} has no block content (is it a Collection row?)`);

	doc.transact(() => {
		applyRichTextToYText(ytext, content);
		yrecord.set('lastEditedBy', actor);
		yrecord.set('lastEditedAt', Date.now());
	});
	return readRecord(yrecord);
}

/** Merges the given key/value pairs into a Collection row's properties (per-key LWW via Y.Map), leaving properties not named in `properties` untouched. */
export function updateRecordProperties(
	doc: Y.Doc,
	id: string,
	properties: Record<string, PropertyValue>,
	actor: ActorId
): WorkspaceRecord {
	const yrecord = recordsMap(doc).get(id);
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);

	doc.transact(() => {
		for (const [key, value] of Object.entries(properties)) {
			setPropertyValue(yrecord, key, value);
		}
		yrecord.set('lastEditedBy', actor);
		yrecord.set('lastEditedAt', Date.now());
	});
	return readRecord(yrecord);
}

/** Changes a Document block's type (e.g. paragraph to heading) in place, without touching its content. */
export function setBlockType(doc: Y.Doc, id: string, blockType: BlockType, actor: ActorId): void {
	const yrecord = recordsMap(doc).get(id);
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);
	doc.transact(() => {
		yrecord.set('blockType', blockType);
		yrecord.set('lastEditedBy', actor);
		yrecord.set('lastEditedAt', Date.now());
	});
}

/** Sets a to-do block's checked state. */
export function setRecordChecked(doc: Y.Doc, id: string, checked: boolean, actor: ActorId): void {
	const yrecord = recordsMap(doc).get(id);
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);
	doc.transact(() => {
		yrecord.set('checked', checked);
		yrecord.set('lastEditedBy', actor);
		yrecord.set('lastEditedAt', Date.now());
	});
}

/** Sets a toggleable block's (e.g. toggle list, heading) collapsed/expanded state. */
export function setRecordCollapsed(
	doc: Y.Doc,
	id: string,
	collapsed: boolean,
	actor: ActorId
): void {
	const yrecord = recordsMap(doc).get(id);
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);
	doc.transact(() => {
		yrecord.set('collapsed', collapsed);
		yrecord.set('lastEditedBy', actor);
		yrecord.set('lastEditedAt', Date.now());
	});
}

/** Sets the record/Collection id a reference-style block (e.g. a page_link or collection_view embed) points at. */
export function setRecordReferencedId(
	doc: Y.Doc,
	id: string,
	referencedRecordId: string,
	actor: ActorId
): void {
	const yrecord = recordsMap(doc).get(id);
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);
	doc.transact(() => {
		yrecord.set('referencedRecordId', referencedRecordId);
		yrecord.set('lastEditedBy', actor);
		yrecord.set('lastEditedAt', Date.now());
	});
}

/**
 * Sets a collection_view block's view type + filters/sort/visible-properties/
 * grouping-property choice — whole-value LWW, same pattern as
 * setRecordReferencedId. One person is expected to be editing a given
 * embed's config at a time, so field-level merge granularity (splitting
 * into prop:-style sub-keys, like Collection row properties do) isn't
 * needed here.
 */
export function setRecordViewConfig(
	doc: Y.Doc,
	id: string,
	viewConfig: EmbeddedViewConfig,
	actor: ActorId
): void {
	const yrecord = recordsMap(doc).get(id);
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);
	doc.transact(() => {
		yrecord.set('viewConfig', viewConfig);
		yrecord.set('lastEditedBy', actor);
		yrecord.set('lastEditedAt', Date.now());
	});
}

/** Deletes a record and removes its id from its parent's sibling order. */
export function deleteRecord(doc: Y.Doc, id: string): void {
	doc.transact(() => {
		const yrecord = recordsMap(doc).get(id);
		if (!yrecord) return;
		const parentId = yrecord.get('parentId')!;
		const kind = parentKindOf(doc, parentId);
		if (kind) {
			const siblingIds = parentRecordIds(doc, parentId, kind);
			// Removes every occurrence, not just the first: a concurrent
			// reorderRecord move of this same id (see below) can leave more
			// than one entry for it in the array, and deleting the record must
			// not leave an orphaned duplicate behind.
			for (let i = siblingIds.length - 1; i >= 0; i--) {
				if (siblingIds.get(i) === id) siblingIds.delete(i, 1);
			}
		}
		recordsMap(doc).delete(id);
	});
}

/** All records belonging to a Document or Collection, in sibling order; empty array if `parentId` isn't a known Document or Collection. */
export function listRecordsForParent(doc: Y.Doc, parentId: string): WorkspaceRecord[] {
	const kind = parentKindOf(doc, parentId);
	if (!kind) return [];
	const ids = parentRecordIds(doc, parentId, kind).toArray();
	// Deduped by id, keeping the first occurrence: a concurrent reorderRecord
	// move of the same block by two actors can each independently insert
	// their own array entry for it (Y.Array has no atomic "move" primitive —
	// see reorderRecord's doc comment), which would otherwise render the same
	// block twice until the duplicate is cleaned up by a later delete.
	const seen = new Set<string>();
	const records: WorkspaceRecord[] = [];
	for (const id of ids) {
		if (seen.has(id)) continue;
		seen.add(id);
		const record = getRecord(doc, id);
		if (record) records.push(record);
	}
	return records;
}

/**
 * Repositions a Document block among its siblings by moving its id within
 * the parent's `recordIds` Y.Array (delete + insert in one transaction) —
 * the same structural mutation createRecord/deleteRecord already make, so
 * the server's generic audit observer attributes it to the *document*
 * (`update_document`), not the moved record, per
 * docs/specifications/audit-coverage.md §2 — nothing on the record's own
 * Y.Map (content, blockType, provenance) is touched. `afterRecordId`
 * omitted moves the block to the very start; passing the last sibling's id
 * moves it to the end.
 *
 * Two actors concurrently moving the *same* block can each independently
 * insert their own new array entry for its id, since Y.Array has no atomic
 * "move" primitive — delete-then-insert is the standard pattern for
 * reordering a Yjs list, and a concurrent delete of the same (already
 * deleted) entry is a safe no-op, but concurrent inserts are two distinct
 * list items even though they carry the same string value. That can't lose
 * either actor's edit (this never touches record content) and can't
 * duplicate the block on screen (listRecordsForParent dedupes by id above),
 * but it can leave a harmless extra array entry until the record is
 * eventually deleted (deleteRecord above removes every occurrence).
 */
export function reorderRecord(doc: Y.Doc, id: string, afterRecordId?: string): void {
	const yrecord = recordsMap(doc).get(id);
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);
	if (afterRecordId === id) {
		throw new ValidationError('Cannot move a block after itself');
	}
	const parentId = yrecord.get('parentId')!;
	const kind = parentKindOf(doc, parentId);
	if (kind !== 'document') {
		throw new ValidationError('reorderRecord only supports blocks within a Document');
	}

	doc.transact(() => {
		const siblingIds = parentRecordIds(doc, parentId, kind);
		const ids = siblingIds.toArray();
		if (!ids.includes(id)) throw new NotFoundError(`Record ${id} not found among siblings`);

		const remaining = ids.filter((siblingId) => siblingId !== id);
		const insertAt = afterRecordId ? remaining.indexOf(afterRecordId) + 1 : 0;
		if (afterRecordId && insertAt === 0) {
			throw new NotFoundError(`Record ${afterRecordId} not found among siblings`);
		}

		// Removes every occurrence of `id`, not just the first, so the live
		// array matches `remaining` (insertAt's basis) exactly before the
		// insert below — a stale duplicate left by an earlier concurrent move
		// (see this function's doc comment) would otherwise still sit ahead of
		// the freshly-inserted entry, and listRecordsForParent's keep-first
		// dedupe would then make this move produce no visible effect at all.
		for (let i = siblingIds.length - 1; i >= 0; i--) {
			if (siblingIds.get(i) === id) siblingIds.delete(i, 1);
		}
		siblingIds.insert(insertAt, [id]);
	});
}

// ---------------------------------------------------------------------------
// Migration primitives (#114/#132) — verbatim structural copies of a
// Document or Collection's exact content into a different Y.Doc (a real
// per-record shard). Deliberately distinct from createDocument/createRecord:
// those compute a fresh order and stamp the calling actor/current time for a
// brand-new record, while a migration must reproduce every field of existing
// state exactly (id, order, content, and original actor/timestamp
// attribution) — nothing here is derived or recomputed.
// ---------------------------------------------------------------------------

/** Copies a Document and all of its records into `targetDoc` exactly as they exist in `sourceDoc`, recursing into records via copyRecordVerbatim. For sharding migrations, not for creating a fresh Document — see the section comment above. */
export function copyDocumentVerbatim(sourceDoc: Y.Doc, targetDoc: Y.Doc, id: string): void {
	const meta = getDocument(sourceDoc, id);
	if (!meta) throw new NotFoundError(`Document ${id} not found in source doc`);

	targetDoc.transact(() => {
		const ymeta = typedYMap<DocumentYShape>(new Y.Map<unknown>());
		ymeta.set('id', meta.id);
		ymeta.set('title', meta.title);
		if (meta.parentDocumentId) ymeta.set('parentDocumentId', meta.parentDocumentId);
		ymeta.set('order', meta.order);
		const recordIds = new Y.Array<string>();
		ymeta.set('recordIds', recordIds);
		documentsMap(targetDoc).set(meta.id, ymeta.raw);

		for (const recordId of meta.recordIds) {
			copyRecordVerbatim(sourceDoc, targetDoc, recordId, 'document');
			recordIds.push([recordId]);
		}
	});
}

/** Copies a Collection and all of its records into `targetDoc` exactly as they exist in `sourceDoc`, recursing into records via copyRecordVerbatim. For sharding migrations, not for creating a fresh Collection — see the section comment above. */
export function copyCollectionVerbatim(sourceDoc: Y.Doc, targetDoc: Y.Doc, id: string): void {
	const meta = getCollection(sourceDoc, id);
	if (!meta) throw new NotFoundError(`Collection ${id} not found in source doc`);

	targetDoc.transact(() => {
		const ymeta = typedYMap<CollectionYShape>(new Y.Map<unknown>());
		ymeta.set('title', meta.title);
		ymeta.set('schema', meta.schema);
		const recordIds = new Y.Array<string>();
		ymeta.set('recordIds', recordIds);
		if (meta.primaryFieldKey) ymeta.set('primaryFieldKey', meta.primaryFieldKey);
		collectionsMap(targetDoc).set(meta.id, ymeta.raw);

		for (const recordId of meta.recordIds) {
			copyRecordVerbatim(sourceDoc, targetDoc, recordId, 'collection');
			recordIds.push([recordId]);
		}
	});
}

/**
 * Copies one record (block or row) into `targetDoc` with every field
 * preserved exactly. Does not touch the parent's recordIds array — callers
 * (copyDocumentVerbatim/copyCollectionVerbatim) push the id themselves, once,
 * in the legacy order already recorded on the source meta.
 */
function copyRecordVerbatim(
	sourceDoc: Y.Doc,
	targetDoc: Y.Doc,
	id: string,
	kind: ParentKind
): void {
	const record = getRecord(sourceDoc, id);
	if (!record) throw new NotFoundError(`Record ${id} not found in source doc`);

	const yrecord = typedYMap<RecordYShape>(new Y.Map<unknown>());
	yrecord.set('id', record.id);
	yrecord.set('parentId', record.parentId);
	yrecord.set('order', record.order);
	yrecord.set('createdBy', record.createdBy);
	yrecord.set('createdAt', record.createdAt);
	yrecord.set('lastEditedBy', record.lastEditedBy);
	yrecord.set('lastEditedAt', record.lastEditedAt);

	if (kind === 'document') {
		yrecord.set('blockType', record.blockType ?? 'paragraph');
		const ytext = new Y.Text();
		if (record.content) applyRichTextToYText(ytext, record.content);
		yrecord.set('content', ytext);
		if (record.checked !== undefined) yrecord.set('checked', record.checked);
		if (record.collapsed !== undefined) yrecord.set('collapsed', record.collapsed);
		if (record.referencedRecordId) yrecord.set('referencedRecordId', record.referencedRecordId);
		if (record.viewConfig) yrecord.set('viewConfig', record.viewConfig);
	} else {
		yrecord.set('isCollectionRow', true);
		for (const [key, value] of Object.entries(record.properties ?? {})) {
			setPropertyValue(yrecord, key, value);
		}
	}

	recordsMap(targetDoc).set(id, yrecord.raw);
}
