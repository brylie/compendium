import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createDocument } from './document-ops';
import {
	addSelectOption,
	appendCollectionField,
	coercePropertyValue,
	countRecordsWithProperty,
	countRecordsWithSelectOption,
	createCollection,
	deleteCollection,
	deleteCollectionProperty,
	deleteSelectOption,
	duplicateCollectionProperty,
	getCollection,
	moveSelectOption,
	previewCollectionPropertyTypeChange,
	resolvePrimaryField,
	setPrimaryField,
	updateCollectionProperty,
	updateCollectionSchema,
	updateCollectionTitle,
	updateSelectOption
} from './collection-ops';
import { createRecord, getRecord } from './record-ops';
import { NotFoundError, ValidationError } from './errors';
import { type ActorId } from './types';

const human: ActorId = { kind: 'human', userId: 'brylie' };
const agent: ActorId = { kind: 'agent', agentId: 'a1', name: 'Research Agent' };

describe('collections: title, schema, and delete edge cases', () => {
	it('updateCollectionTitle renames a collection', () => {
		const doc = new Y.Doc();
		const collection = createCollection(doc, { title: 'Old', schema: [] });
		updateCollectionTitle(doc, collection.id, 'New');
		expect(getCollection(doc, collection.id)?.title).toBe('New');
	});

	it('updateCollectionTitle throws NotFoundError for a nonexistent collection', () => {
		const doc = new Y.Doc();
		expect(() => updateCollectionTitle(doc, 'missing', 'x')).toThrow(NotFoundError);
	});

	it('updateCollectionSchema replaces the schema', () => {
		const doc = new Y.Doc();
		const collection = createCollection(doc, { title: 'Tasks', schema: [] });
		const schema = [{ key: 'status', label: 'Status', type: 'select' as const }];
		updateCollectionSchema(doc, collection.id, schema);
		expect(getCollection(doc, collection.id)?.schema).toEqual(schema);
	});

	it('updateCollectionSchema throws NotFoundError for a nonexistent collection', () => {
		const doc = new Y.Doc();
		expect(() => updateCollectionSchema(doc, 'missing', [])).toThrow(NotFoundError);
	});

	it('deleteCollection removes it and its rows', () => {
		const doc = new Y.Doc();
		const collection = createCollection(doc, { title: 'Tasks', schema: [] });
		const row = createRecord(doc, { parentId: collection.id, properties: {} }, human);

		deleteCollection(doc, collection.id);

		expect(getCollection(doc, collection.id)).toBeUndefined();
		expect(getRecord(doc, row.id)).toBeUndefined();
	});

	it('deleteCollection is a no-op for a nonexistent id', () => {
		const doc = new Y.Doc();
		expect(() => deleteCollection(doc, 'missing')).not.toThrow();
	});

	it('getCollection returns undefined for a nonexistent id', () => {
		const doc = new Y.Doc();
		expect(getCollection(doc, 'missing')).toBeUndefined();
	});
});

describe('coercePropertyValue', () => {
	it('returns the value unchanged when the type already matches', () => {
		const value = { type: 'text' as const, value: 'hi' };
		expect(coercePropertyValue(value, 'text')).toBe(value);
	});

	it('converts number/date/checkbox to text losslessly', () => {
		expect(coercePropertyValue({ type: 'number', value: 7 }, 'text')).toEqual({
			type: 'text',
			value: '7'
		});
		expect(coercePropertyValue({ type: 'date', value: '2026-01-01' }, 'text')).toEqual({
			type: 'text',
			value: '2026-01-01'
		});
		expect(coercePropertyValue({ type: 'checkbox', value: true }, 'text')).toEqual({
			type: 'text',
			value: 'true'
		});
	});

	it('parses a numeric-looking text value into number, and rejects a non-numeric one', () => {
		expect(coercePropertyValue({ type: 'text', value: '42' }, 'number')).toEqual({
			type: 'number',
			value: 42
		});
		expect(coercePropertyValue({ type: 'text', value: 'abc' }, 'number')).toBeUndefined();
		expect(coercePropertyValue({ type: 'text', value: '' }, 'number')).toBeUndefined();
	});

	it('parses "true"/"false" text into checkbox, and rejects anything else', () => {
		expect(coercePropertyValue({ type: 'text', value: 'true' }, 'checkbox')).toEqual({
			type: 'checkbox',
			value: true
		});
		expect(coercePropertyValue({ type: 'text', value: 'false' }, 'checkbox')).toEqual({
			type: 'checkbox',
			value: false
		});
		expect(coercePropertyValue({ type: 'text', value: 'maybe' }, 'checkbox')).toBeUndefined();
	});

	it('has no safe conversion into date/select/relation', () => {
		expect(coercePropertyValue({ type: 'text', value: '2026-01-01' }, 'date')).toBeUndefined();
		expect(coercePropertyValue({ type: 'text', value: 'x' }, 'select')).toBeUndefined();
		expect(coercePropertyValue({ type: 'text', value: 'x' }, 'relation')).toBeUndefined();
	});
});

describe('appendCollectionField: reads the current Yjs schema atomically (issue #189)', () => {
	it('two sequential appends from one initial schema snapshot both survive, in submission order', () => {
		const doc = new Y.Doc();
		const collection = createCollection(doc, {
			title: 'Tasks',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});

		// Both calls read the initial `[name]` schema — appendCollectionField
		// must not trust that snapshot for the second call, or it would
		// silently drop the first appended field.
		appendCollectionField(doc, collection.id, { key: 'status', label: 'Status', type: 'select' });
		appendCollectionField(doc, collection.id, { key: 'due', label: 'Due', type: 'date' });

		expect(getCollection(doc, collection.id)?.schema.map((p) => p.key)).toEqual([
			'name',
			'status',
			'due'
		]);
	});
});

describe('collection field lifecycle: rename, retype, duplicate, delete', () => {
	function setupCollection(doc: Y.Doc) {
		const collection = createCollection(doc, {
			title: 'Tasks',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		const withValue = createRecord(
			doc,
			{ parentId: collection.id, properties: { name: { type: 'text', value: 'Alice' } } },
			human
		);
		const withoutValue = createRecord(doc, { parentId: collection.id, properties: {} }, human);
		return { collection, withValue, withoutValue };
	}

	it('updateCollectionProperty renames a field without touching its type or values', () => {
		const doc = new Y.Doc();
		const { collection, withValue } = setupCollection(doc);

		updateCollectionProperty(doc, collection.id, 'name', { label: 'Full name' });

		expect(getCollection(doc, collection.id)?.schema).toEqual([
			{ key: 'name', label: 'Full name', type: 'text', options: undefined }
		]);
		expect(getRecord(doc, withValue.id)?.properties?.name).toEqual({
			type: 'text',
			value: 'Alice'
		});
	});

	it('updateCollectionProperty retypes a field and migrates coercible values, clearing the rest', () => {
		const doc = new Y.Doc();
		const collection = createCollection(doc, {
			title: 'Tasks',
			schema: [{ key: 'qty', label: 'Qty', type: 'text' }]
		});
		const numeric = createRecord(
			doc,
			{ parentId: collection.id, properties: { qty: { type: 'text', value: '5' } } },
			human
		);
		const nonNumeric = createRecord(
			doc,
			{ parentId: collection.id, properties: { qty: { type: 'text', value: 'lots' } } },
			human
		);

		updateCollectionProperty(doc, collection.id, 'qty', { type: 'number' });

		expect(getCollection(doc, collection.id)?.schema[0].type).toBe('number');
		expect(getRecord(doc, numeric.id)?.properties?.qty).toEqual({ type: 'number', value: 5 });
		expect(getRecord(doc, nonNumeric.id)?.properties?.qty).toBeUndefined();
	});

	it("updateCollectionProperty sets, preserves, clears, and drops a relation field's targetCollectionId (issue #15)", () => {
		const doc = new Y.Doc();
		const collection = createCollection(doc, {
			title: 'Tasks',
			schema: [{ key: 'assignee', label: 'Assignee', type: 'relation' }]
		});
		const people = createCollection(doc, { title: 'People', schema: [] });

		// Retyping into 'relation' with a targetCollectionId in the same patch
		// sets it.
		updateCollectionProperty(doc, collection.id, 'assignee', {
			type: 'relation',
			targetCollectionId: people.id
		});
		expect(getCollection(doc, collection.id)?.schema[0].targetCollectionId).toBe(people.id);

		// A save that leaves the field as 'relation' without naming
		// targetCollectionId at all preserves the existing one.
		updateCollectionProperty(doc, collection.id, 'assignee', { label: 'Owner' });
		expect(getCollection(doc, collection.id)?.schema[0].targetCollectionId).toBe(people.id);

		// Explicit `null` clears it while staying 'relation'.
		updateCollectionProperty(doc, collection.id, 'assignee', {
			type: 'relation',
			targetCollectionId: null
		});
		expect(getCollection(doc, collection.id)?.schema[0].targetCollectionId).toBeUndefined();

		// Retyping away from 'relation' drops targetCollectionId even without
		// an explicit clear — same rationale as dropping select options.
		updateCollectionProperty(doc, collection.id, 'assignee', {
			type: 'relation',
			targetCollectionId: people.id
		});
		updateCollectionProperty(doc, collection.id, 'assignee', { type: 'text' });
		expect(getCollection(doc, collection.id)?.schema[0].targetCollectionId).toBeUndefined();
	});

	it("updateCollectionProperty never persists targetCollectionId on a non-relation field, even if a caller passes one — so it can't resurface on a later retype back to relation", () => {
		const doc = new Y.Doc();
		const collection = createCollection(doc, {
			title: 'Tasks',
			schema: [{ key: 'assignee', label: 'Assignee', type: 'text' }]
		});
		const people = createCollection(doc, { title: 'People', schema: [] });

		// A caller passing targetCollectionId while retyping to something other
		// than 'relation' must not have it take effect.
		updateCollectionProperty(doc, collection.id, 'assignee', {
			type: 'text',
			targetCollectionId: people.id
		});
		expect(getCollection(doc, collection.id)?.schema[0].targetCollectionId).toBeUndefined();

		// A later retype to 'relation' with no target of its own must not pick
		// up that stray id via the "preserve current.targetCollectionId" path —
		// there's nothing valid to preserve, since it was never actually set.
		updateCollectionProperty(doc, collection.id, 'assignee', { type: 'relation' });
		expect(getCollection(doc, collection.id)?.schema[0].targetCollectionId).toBeUndefined();
	});

	it('updateCollectionProperty throws NotFoundError for an unknown collection or field', () => {
		const doc = new Y.Doc();
		const { collection } = setupCollection(doc);
		expect(() => updateCollectionProperty(doc, 'missing', 'name', { label: 'x' })).toThrow(
			NotFoundError
		);
		expect(() => updateCollectionProperty(doc, collection.id, 'missing', { label: 'x' })).toThrow(
			NotFoundError
		);
	});

	it('previewCollectionPropertyTypeChange reports how many filled records would lose their value', () => {
		const doc = new Y.Doc();
		const collection = createCollection(doc, {
			title: 'Tasks',
			schema: [{ key: 'qty', label: 'Qty', type: 'text' }]
		});
		createRecord(
			doc,
			{ parentId: collection.id, properties: { qty: { type: 'text', value: '5' } } },
			human
		);
		createRecord(
			doc,
			{ parentId: collection.id, properties: { qty: { type: 'text', value: 'lots' } } },
			human
		);
		createRecord(doc, { parentId: collection.id, properties: {} }, human);

		expect(previewCollectionPropertyTypeChange(doc, collection.id, 'qty', 'number')).toEqual({
			affected: 1,
			total: 2
		});
	});

	it('duplicateCollectionProperty clones the field definition and copies existing values', () => {
		const doc = new Y.Doc();
		const { collection, withValue, withoutValue } = setupCollection(doc);

		const copy = duplicateCollectionProperty(doc, collection.id, 'name');

		expect(copy.label).toBe('Name copy');
		expect(copy.key).not.toBe('name');
		const schema = getCollection(doc, collection.id)?.schema ?? [];
		expect(schema.map((p) => p.key)).toEqual(['name', copy.key]);
		expect(getRecord(doc, withValue.id)?.properties?.[copy.key]).toEqual({
			type: 'text',
			value: 'Alice'
		});
		expect(getRecord(doc, withoutValue.id)?.properties?.[copy.key]).toBeUndefined();
	});

	it("duplicateCollectionProperty carries a relation field's targetCollectionId over to the copy", () => {
		const doc = new Y.Doc();
		const people = createCollection(doc, { title: 'People', schema: [] });
		const collection = createCollection(doc, {
			title: 'Tasks',
			schema: [
				{ key: 'assignee', label: 'Assignee', type: 'relation', targetCollectionId: people.id }
			]
		});

		const copy = duplicateCollectionProperty(doc, collection.id, 'assignee');

		expect(copy.targetCollectionId).toBe(people.id);
	});

	it('duplicateCollectionProperty throws NotFoundError for an unknown collection or field', () => {
		const doc = new Y.Doc();
		const { collection } = setupCollection(doc);
		expect(() => duplicateCollectionProperty(doc, 'missing', 'name')).toThrow(NotFoundError);
		expect(() => duplicateCollectionProperty(doc, collection.id, 'missing')).toThrow(NotFoundError);
	});

	it('countRecordsWithProperty counts only records holding a value for that key', () => {
		const doc = new Y.Doc();
		const { collection } = setupCollection(doc);
		expect(countRecordsWithProperty(doc, collection.id, 'name')).toBe(1);
		expect(countRecordsWithProperty(doc, collection.id, 'missing-key')).toBe(0);
	});

	it('deleteCollectionProperty removes the field from schema and strips its value off every record', () => {
		const doc = new Y.Doc();
		const { collection, withValue, withoutValue } = setupCollection(doc);

		deleteCollectionProperty(doc, collection.id, 'name');

		expect(getCollection(doc, collection.id)?.schema).toEqual([]);
		expect(getRecord(doc, withValue.id)?.properties?.name).toBeUndefined();
		expect(getRecord(doc, withoutValue.id)?.properties?.name).toBeUndefined();
	});

	it('deleteCollectionProperty repairs an embedded collection_view block that referenced the deleted field', () => {
		const doc = new Y.Doc();
		const { collection } = setupCollection(doc);
		const document = createDocument(doc, { title: 'Doc' });
		const block = createRecord(
			doc,
			{
				parentId: document.id,
				blockType: 'collection_view',
				referencedRecordId: collection.id,
				viewConfig: {
					viewType: 'table',
					filters: [{ propertyKey: 'name', op: 'is', value: 'x' }],
					visibleProperties: ['name'],
					groupBy: 'name',
					sort: { mode: 'property', propertyKey: 'name', direction: 'asc' }
				}
			},
			human
		);

		deleteCollectionProperty(doc, collection.id, 'name');

		expect(getRecord(doc, block.id)?.viewConfig).toEqual({
			viewType: 'table',
			filters: [],
			visibleProperties: [],
			groupBy: undefined,
			sort: { mode: 'manual' }
		});
	});

	it('deleteCollectionProperty repairs an embed living in a separate documentsDoc (#120: Collections are sharded, Documents are not)', () => {
		const collectionDoc = new Y.Doc();
		const { collection } = setupCollection(collectionDoc);
		const documentsDoc = new Y.Doc();
		const document = createDocument(documentsDoc, { title: 'Doc' });
		const block = createRecord(
			documentsDoc,
			{
				parentId: document.id,
				blockType: 'collection_view',
				referencedRecordId: collection.id,
				viewConfig: { viewType: 'table', groupBy: 'name' }
			},
			human
		);

		deleteCollectionProperty(collectionDoc, collection.id, 'name', documentsDoc);

		expect(getRecord(documentsDoc, block.id)?.viewConfig?.groupBy).toBeUndefined();
	});

	it('deleteCollectionProperty leaves an embed that references a different collection untouched', () => {
		const doc = new Y.Doc();
		const { collection } = setupCollection(doc);
		const other = createCollection(doc, {
			title: 'Other',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		const document = createDocument(doc, { title: 'Doc' });
		const viewConfig = {
			viewType: 'table' as const,
			filters: [{ propertyKey: 'name', op: 'is' as const, value: 'x' }],
			visibleProperties: ['name'],
			groupBy: 'name',
			sort: { mode: 'property' as const, propertyKey: 'name', direction: 'asc' as const }
		};
		const block = createRecord(
			doc,
			{
				parentId: document.id,
				blockType: 'collection_view',
				referencedRecordId: other.id,
				viewConfig
			},
			human
		);

		deleteCollectionProperty(doc, collection.id, 'name');

		expect(getRecord(doc, block.id)?.viewConfig).toEqual(viewConfig);
	});

	it('deleteCollectionProperty throws NotFoundError for an unknown collection', () => {
		const doc = new Y.Doc();
		expect(() => deleteCollectionProperty(doc, 'missing', 'name')).toThrow(NotFoundError);
	});
});

describe('primary field: resolve, set, and migration on delete/retype (issue #96)', () => {
	function setupCollection(doc: Y.Doc) {
		return createCollection(doc, {
			title: 'Tasks',
			schema: [
				{ key: 'name', label: 'Name', type: 'text' },
				{ key: 'notes', label: 'Notes', type: 'text' },
				{ key: 'assignees', label: 'Assignees', type: 'relation' }
			]
		});
	}

	it('resolvePrimaryField falls back to the first text field when nothing is explicitly set', () => {
		const doc = new Y.Doc();
		const collection = setupCollection(doc);
		expect(resolvePrimaryField(collection.schema, undefined)?.key).toBe('name');
	});

	it('resolvePrimaryField returns undefined when no eligible field exists', () => {
		const schema = [{ key: 'assignees', label: 'Assignees', type: 'relation' as const }];
		expect(resolvePrimaryField(schema, undefined)).toBeUndefined();
	});

	it('resolvePrimaryField returns undefined when an eligible field exists but none is type text — the fallback only considers text fields', () => {
		const schema = [{ key: 'qty', label: 'Qty', type: 'number' as const }];
		expect(resolvePrimaryField(schema, undefined)).toBeUndefined();
	});

	it('setPrimaryField chooses an explicit field, overriding the first-text fallback', () => {
		const doc = new Y.Doc();
		const collection = setupCollection(doc);

		setPrimaryField(doc, collection.id, 'notes');

		const schema = getCollection(doc, collection.id)!.schema;
		expect(getCollection(doc, collection.id)?.primaryFieldKey).toBe('notes');
		expect(resolvePrimaryField(schema, 'notes')?.key).toBe('notes');
	});

	it('setPrimaryField(null) clears the explicit choice, reverting to the automatic fallback', () => {
		const doc = new Y.Doc();
		const collection = setupCollection(doc);
		setPrimaryField(doc, collection.id, 'notes');

		setPrimaryField(doc, collection.id, null);

		expect(getCollection(doc, collection.id)?.primaryFieldKey).toBeUndefined();
	});

	it('setPrimaryField rejects a relation field — it has no single display value of its own', () => {
		const doc = new Y.Doc();
		const collection = setupCollection(doc);
		expect(() => setPrimaryField(doc, collection.id, 'assignees')).toThrow(ValidationError);
		expect(getCollection(doc, collection.id)?.primaryFieldKey).toBeUndefined();
	});

	it('setPrimaryField throws NotFoundError for an unknown collection or field', () => {
		const doc = new Y.Doc();
		const collection = setupCollection(doc);
		expect(() => setPrimaryField(doc, 'missing', 'name')).toThrow(NotFoundError);
		expect(() => setPrimaryField(doc, collection.id, 'missing')).toThrow(NotFoundError);
	});

	it('reordering the schema does not change an explicitly chosen primary field', () => {
		const doc = new Y.Doc();
		const collection = setupCollection(doc);
		setPrimaryField(doc, collection.id, 'notes');

		const schema = getCollection(doc, collection.id)!.schema;
		updateCollectionSchema(doc, collection.id, [...schema].reverse());

		const reordered = getCollection(doc, collection.id)!;
		expect(resolvePrimaryField(reordered.schema, reordered.primaryFieldKey)?.key).toBe('notes');
	});

	it('deleteCollectionProperty clears primaryFieldKey when the deleted field was the primary', () => {
		const doc = new Y.Doc();
		const collection = setupCollection(doc);
		setPrimaryField(doc, collection.id, 'notes');

		deleteCollectionProperty(doc, collection.id, 'notes');

		expect(getCollection(doc, collection.id)?.primaryFieldKey).toBeUndefined();
		// Falls back to the remaining text field rather than showing no title.
		const schema = getCollection(doc, collection.id)!.schema;
		expect(resolvePrimaryField(schema, undefined)?.key).toBe('name');
	});

	it('deleteCollectionProperty leaves primaryFieldKey untouched when an unrelated field is deleted', () => {
		const doc = new Y.Doc();
		const collection = setupCollection(doc);
		setPrimaryField(doc, collection.id, 'notes');

		deleteCollectionProperty(doc, collection.id, 'assignees');

		expect(getCollection(doc, collection.id)?.primaryFieldKey).toBe('notes');
	});

	it('updateCollectionProperty clears primaryFieldKey when retyping it to an ineligible type', () => {
		const doc = new Y.Doc();
		const collection = setupCollection(doc);
		setPrimaryField(doc, collection.id, 'notes');

		updateCollectionProperty(doc, collection.id, 'notes', { type: 'relation' });

		expect(getCollection(doc, collection.id)?.primaryFieldKey).toBeUndefined();
	});

	it('updateCollectionProperty preserves primaryFieldKey when retyping it to another eligible type', () => {
		const doc = new Y.Doc();
		const collection = setupCollection(doc);
		setPrimaryField(doc, collection.id, 'notes');

		updateCollectionProperty(doc, collection.id, 'notes', { type: 'number' });

		expect(getCollection(doc, collection.id)?.primaryFieldKey).toBe('notes');
	});
});

describe('select option lifecycle: add, rename, recolor, reorder, delete (issue #94)', () => {
	function setupSelectCollection(doc: Y.Doc) {
		const collection = createCollection(doc, {
			title: 'Tasks',
			schema: [
				{
					key: 'status',
					label: 'Status',
					type: 'select',
					options: [
						{ id: 'todo', label: 'To do', color: 'oklch(60% 0.01 250)' },
						{ id: 'doing', label: 'Doing', color: 'oklch(62% 0.18 25)' },
						{ id: 'done', label: 'Done', color: 'oklch(65% 0.14 145)' }
					]
				}
			]
		});
		return { collection };
	}

	function statusOptions(doc: Y.Doc, collectionId: string) {
		return getCollection(doc, collectionId)?.schema[0].options ?? [];
	}

	it('addSelectOption appends with a fresh id and an auto-assigned color', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);

		const option = addSelectOption(doc, collection.id, 'status', 'Blocked');

		expect(option.label).toBe('Blocked');
		expect(option.color).toBeTruthy();
		const options = statusOptions(doc, collection.id);
		expect(options.map((o) => o.label)).toEqual(['To do', 'Doing', 'Done', 'Blocked']);
		expect(new Set(options.map((o) => o.id)).size).toBe(4);
	});

	it('addSelectOption rejects a blank label', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);
		expect(() => addSelectOption(doc, collection.id, 'status', '   ')).toThrow(ValidationError);
	});

	it('addSelectOption rejects a case-insensitive duplicate label', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);
		expect(() => addSelectOption(doc, collection.id, 'status', 'to do')).toThrow(ValidationError);
		expect(statusOptions(doc, collection.id)).toHaveLength(3);
	});

	it('addSelectOption throws NotFoundError for an unknown collection/field, ValidationError for a non-select field', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);
		expect(() => addSelectOption(doc, 'missing', 'status', 'x')).toThrow(NotFoundError);
		expect(() => addSelectOption(doc, collection.id, 'missing', 'x')).toThrow(NotFoundError);

		const withText = createCollection(doc, {
			title: 'Other',
			schema: [{ key: 'name', label: 'Name', type: 'text' }]
		});
		expect(() => addSelectOption(doc, withText.id, 'name', 'x')).toThrow(ValidationError);
	});

	it('updateSelectOption renames an option without touching its color or id', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);

		updateSelectOption(doc, collection.id, 'status', 'doing', { label: 'In progress' });

		expect(statusOptions(doc, collection.id)).toEqual([
			{ id: 'todo', label: 'To do', color: 'oklch(60% 0.01 250)' },
			{ id: 'doing', label: 'In progress', color: 'oklch(62% 0.18 25)' },
			{ id: 'done', label: 'Done', color: 'oklch(65% 0.14 145)' }
		]);
	});

	it('updateSelectOption recolors an option without touching its label', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);

		updateSelectOption(doc, collection.id, 'status', 'todo', { color: 'oklch(65% 0.15 350)' });

		expect(statusOptions(doc, collection.id)[0]).toEqual({
			id: 'todo',
			label: 'To do',
			color: 'oklch(65% 0.15 350)'
		});
	});

	it('updateSelectOption rejects renaming to a blank or already-used label, leaving the option unchanged', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);

		expect(() =>
			updateSelectOption(doc, collection.id, 'status', 'doing', { label: 'done' })
		).toThrow(ValidationError);
		expect(() => updateSelectOption(doc, collection.id, 'status', 'doing', { label: ' ' })).toThrow(
			ValidationError
		);
		expect(statusOptions(doc, collection.id)[1].label).toBe('Doing');
	});

	it('updateSelectOption allows re-saving an option under its own unchanged label', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);
		expect(() =>
			updateSelectOption(doc, collection.id, 'status', 'doing', { label: 'Doing' })
		).not.toThrow();
	});

	it('updateSelectOption throws NotFoundError for an unknown option', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);
		expect(() =>
			updateSelectOption(doc, collection.id, 'status', 'missing', { label: 'x' })
		).toThrow(NotFoundError);
	});

	it('moveSelectOption reorders within bounds and is the primitive behind Board column/dropdown/filter order', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);

		moveSelectOption(doc, collection.id, 'status', 'done', 0);

		expect(statusOptions(doc, collection.id).map((o) => o.id)).toEqual(['done', 'todo', 'doing']);
	});

	it('moveSelectOption clamps an out-of-range target index instead of throwing', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);

		moveSelectOption(doc, collection.id, 'status', 'todo', 99);

		expect(statusOptions(doc, collection.id).map((o) => o.id)).toEqual(['doing', 'done', 'todo']);
	});

	it('moveSelectOption is a no-op when the target index equals the current index', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);
		const before = statusOptions(doc, collection.id);

		moveSelectOption(doc, collection.id, 'status', 'doing', 1);

		expect(statusOptions(doc, collection.id)).toEqual(before);
	});

	it('countRecordsWithSelectOption counts only records currently set to that option', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);
		createRecord(
			doc,
			{ parentId: collection.id, properties: { status: { type: 'select', value: 'todo' } } },
			human
		);
		createRecord(
			doc,
			{ parentId: collection.id, properties: { status: { type: 'select', value: 'todo' } } },
			human
		);
		createRecord(
			doc,
			{ parentId: collection.id, properties: { status: { type: 'select', value: 'done' } } },
			human
		);
		createRecord(doc, { parentId: collection.id, properties: {} }, human);

		expect(countRecordsWithSelectOption(doc, collection.id, 'status', 'todo')).toBe(2);
		expect(countRecordsWithSelectOption(doc, collection.id, 'status', 'done')).toBe(1);
		expect(countRecordsWithSelectOption(doc, collection.id, 'status', 'missing')).toBe(0);
	});

	it('deleteSelectOption removes the option and clears it (to the documented unassigned state) on every record that held it, leaving other records untouched', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);
		const wasTodo = createRecord(
			doc,
			{ parentId: collection.id, properties: { status: { type: 'select', value: 'todo' } } },
			human
		);
		const wasDone = createRecord(
			doc,
			{ parentId: collection.id, properties: { status: { type: 'select', value: 'done' } } },
			human
		);

		deleteSelectOption(doc, collection.id, 'status', 'todo');

		expect(statusOptions(doc, collection.id).map((o) => o.id)).toEqual(['doing', 'done']);
		expect(getRecord(doc, wasTodo.id)?.properties?.status).toBeUndefined();
		expect(getRecord(doc, wasDone.id)?.properties?.status).toEqual({
			type: 'select',
			value: 'done'
		});
	});

	it('deleteSelectOption strips a filter referencing the deleted option from an embedded view, leaving groupBy/other filters alone', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);
		const document = createDocument(doc, { title: 'Doc' });
		const block = createRecord(
			doc,
			{
				parentId: document.id,
				blockType: 'collection_view',
				referencedRecordId: collection.id,
				viewConfig: {
					viewType: 'board',
					filters: [
						{ propertyKey: 'status', op: 'is', value: 'todo' },
						{ propertyKey: 'status', op: 'is_not', value: 'done' }
					],
					groupBy: 'status'
				}
			},
			human
		);

		deleteSelectOption(doc, collection.id, 'status', 'todo');

		expect(getRecord(doc, block.id)?.viewConfig).toEqual({
			viewType: 'board',
			filters: [{ propertyKey: 'status', op: 'is_not', value: 'done' }],
			groupBy: 'status'
		});
	});

	it('deleteSelectOption repairs an embed living in a separate documentsDoc (#120: Collections are sharded, Documents are not)', () => {
		const collectionDoc = new Y.Doc();
		const { collection } = setupSelectCollection(collectionDoc);
		const documentsDoc = new Y.Doc();
		const document = createDocument(documentsDoc, { title: 'Doc' });
		const block = createRecord(
			documentsDoc,
			{
				parentId: document.id,
				blockType: 'collection_view',
				referencedRecordId: collection.id,
				viewConfig: {
					viewType: 'board',
					filters: [{ propertyKey: 'status', op: 'is', value: 'todo' }],
					groupBy: 'status'
				}
			},
			human
		);

		deleteSelectOption(collectionDoc, collection.id, 'status', 'todo', documentsDoc);

		expect(getRecord(documentsDoc, block.id)?.viewConfig?.filters).toEqual([]);
	});

	it('deleteSelectOption is a no-op when the option is already gone', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);
		deleteSelectOption(doc, collection.id, 'status', 'missing');
		expect(statusOptions(doc, collection.id)).toHaveLength(3);
	});

	it('deleteSelectOption throws NotFoundError for an unknown collection or field', () => {
		const doc = new Y.Doc();
		const { collection } = setupSelectCollection(doc);
		expect(() => deleteSelectOption(doc, 'missing', 'status', 'todo')).toThrow(NotFoundError);
		expect(() => deleteSelectOption(doc, collection.id, 'missing', 'todo')).toThrow(NotFoundError);
	});
});
