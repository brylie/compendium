import * as Y from 'yjs';
import { nanoid } from 'nanoid';
import type { CollectionMeta, PropertyDefinition, PropertyType, PropertyValue } from './types';
import { type TypedYMap, typedYMap } from './yjs-typed';
import {
	type CollectionYShape,
	collectionsMap,
	deletePropertyValue,
	recordsMap,
	setPropertyValue
} from './yjs-shapes';
import { migrateLegacyViewConfig, readViewConfig, writeViewConfigField } from './view-config';
import { nextSelectOptionColor } from './select-colors';
import { NotFoundError, ValidationError } from './errors';
import { listRecordsForParent } from './record-ops';

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

/** Renames a Collection. Throws NotFoundError if it doesn't exist. */
export function updateCollectionTitle(doc: Y.Doc, id: string, title: string): void {
	const ymeta = collectionsMap(doc).get(id);
	if (!ymeta) throw new NotFoundError(`Collection ${id} not found`);
	ymeta.set('title', title);
}

/** Replaces a Collection's entire schema wholesale, with no per-field migration of existing record values — use updateCollectionProperty for a single-field rename/retype that needs that. */
export function updateCollectionSchema(doc: Y.Doc, id: string, schema: PropertyDefinition[]): void {
	const ymeta = collectionsMap(doc).get(id);
	if (!ymeta) throw new NotFoundError(`Collection ${id} not found`);
	ymeta.set('schema', schema);
}

/** Appends one field to a Collection's schema, reading the current schema from Yjs inside the same transaction rather than trusting a caller-supplied snapshot — two rapid appends from the same reactive snapshot would otherwise race, with the second silently dropping the first. */
export function appendCollectionField(doc: Y.Doc, id: string, field: PropertyDefinition): void {
	const ymeta = collectionsMap(doc).get(id);
	if (!ymeta) throw new NotFoundError(`Collection ${id} not found`);
	doc.transact(() => {
		const schema = ymeta.get('schema') ?? [];
		ymeta.set('schema', [...schema, field]);
	});
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

/** Renames, retypes, and/or re-targets one field in a Collection's schema, migrating (or clearing, per `coercePropertyValue`) every record's existing value when `patch.type` changes. */
export function updateCollectionProperty(
	doc: Y.Doc,
	collectionId: string,
	propertyKey: string,
	patch: { label?: string; type?: PropertyType; targetCollectionId?: string | null }
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
		// Same rationale as options above: targetCollectionId only means
		// anything for 'relation'. Checked on nextType first, not merely
		// whether patch.targetCollectionId was given — a caller passing one
		// alongside a non-'relation' type must never persist it, or a later
		// retype back to 'relation' with no explicit target of its own would
		// silently resurrect that stale id via the `current.targetCollectionId`
		// fallback below. An explicit patch.targetCollectionId (`null` clears
		// it) wins while staying 'relation'; otherwise it survives an edit
		// that leaves the field as 'relation', and is dropped on any retype
		// away from it.
		let nextTargetCollectionId: string | undefined;
		if (nextType !== 'relation') {
			nextTargetCollectionId = undefined;
		} else if (patch.targetCollectionId !== undefined) {
			nextTargetCollectionId = patch.targetCollectionId ?? undefined;
		} else {
			nextTargetCollectionId = current.targetCollectionId;
		}
		const next: PropertyDefinition = {
			...current,
			label: patch.label ?? current.label,
			type: nextType,
			options: nextOptions,
			targetCollectionId: nextTargetCollectionId
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
		migrateLegacyViewConfig(yrecord);
		const config = readViewConfig(yrecord);
		if (!config) return;

		// Each member is rewritten independently (only if it actually
		// referenced the removed field) so this repair never disturbs a
		// concurrent edit to an unrelated member — same per-field merge
		// granularity as the rest of viewConfig (issue #71).
		if (config.filters?.some((f) => f.propertyKey === propertyKey)) {
			writeViewConfigField(
				yrecord,
				'filters',
				config.filters.filter((f) => f.propertyKey !== propertyKey)
			);
		}
		if (config.visibleProperties?.includes(propertyKey)) {
			writeViewConfigField(
				yrecord,
				'visibleProperties',
				config.visibleProperties.filter((k) => k !== propertyKey)
			);
		}
		if (config.groupBy === propertyKey) {
			writeViewConfigField(yrecord, 'groupBy', undefined);
		}
		if (config.sort?.propertyKey === propertyKey) {
			writeViewConfigField(yrecord, 'sort', { mode: 'manual' });
		}
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
		migrateLegacyViewConfig(yrecord);
		const config = readViewConfig(yrecord);
		if (!config?.filters?.length) return;
		const nextFilters = config.filters.filter(
			(f) => !(f.propertyKey === propertyKey && f.value === optionId)
		);
		if (nextFilters.length !== config.filters.length) {
			writeViewConfigField(yrecord, 'filters', nextFilters);
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
