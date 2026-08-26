// Shared Collection view-projection semantics — the "smallest shared view
// configuration" issue #9 asks for, scoped to what Table/Board/Calendar
// actually need. This is deliberately a minimal slice of #32's full
// ambition (no saved-view persistence, no server-side/read-model filtering
// for MCP's query_collection): pure functions over an already-loaded
// records array, so Table, Board, and Calendar all project the same live
// Yjs-observed data through one path instead of three divergent ones.
//
// Per docs/specifications/data-model.md §2, a view "may have configuration
// such as filters, sorts, grouping, visible properties, and a layout-specific
// driving property, but it never copies records, changes their identity, or
// introduces view-specific row fields" — this module only ever reads
// WorkspaceRecord[]/PropertyDefinition[] and returns derived arrays; nothing
// here mutates or persists anything.

import type * as Y from 'yjs';
import { getCollection, listRecordsForParent } from './records';
import type { CollectionMeta, PropertyDefinition, PropertyValue, WorkspaceRecord } from './types';

export interface CollectionView {
	collection: CollectionMeta | undefined;
	records: WorkspaceRecord[];
}

// The one Collection query/projection path Table, Board, and Calendar all
// call — issue #9's "reuse one Collection query/projection path so Table,
// Board, and Calendar immediately show the same record edits" requirement.
export function getCollectionView(doc: Y.Doc, collectionId: string): CollectionView {
	return {
		collection: getCollection(doc, collectionId),
		records: listRecordsForParent(doc, collectionId)
	};
}

export type ViewFilterOp = 'is' | 'is_not' | 'is_empty' | 'is_not_empty';

export interface ViewFilter {
	propertyKey: string;
	op: ViewFilterOp;
	value?: string;
}

export type SortDirection = 'asc' | 'desc';

export interface ViewSort {
	mode: 'manual' | 'property';
	propertyKey?: string; // required when mode === 'property'
	direction?: SortDirection; // defaults to 'asc'
}

export interface ViewConfig {
	filters?: ViewFilter[];
	sort?: ViewSort;
	visibleProperties?: string[]; // property keys; undefined = all visible
	groupBy?: string; // property key driving Board columns / Calendar buckets
}

type Comparable = string | number | boolean | undefined;

function comparableValue(value: PropertyValue | undefined): Comparable {
	if (!value) return undefined;
	switch (value.type) {
		case 'text':
		case 'select':
		case 'date':
			return value.value;
		case 'number':
			return value.value;
		case 'checkbox':
			return value.value;
		case 'relation':
			return value.value.join(',');
	}
}

function isEmptyComparable(value: Comparable): boolean {
	return value === undefined || value === '';
}

export function applyFilters(
	records: WorkspaceRecord[],
	filters: ViewFilter[] | undefined
): WorkspaceRecord[] {
	if (!filters || filters.length === 0) return records;
	return records.filter((record) =>
		filters.every((filter) => {
			const comparable = comparableValue(record.properties?.[filter.propertyKey]);
			switch (filter.op) {
				case 'is_empty':
					return isEmptyComparable(comparable);
				case 'is_not_empty':
					return !isEmptyComparable(comparable);
				case 'is':
					return String(comparable ?? '') === (filter.value ?? '');
				case 'is_not':
					return String(comparable ?? '') !== (filter.value ?? '');
			}
		})
	);
}

export function applySort(
	records: WorkspaceRecord[],
	sort: ViewSort | undefined
): WorkspaceRecord[] {
	if (!sort || sort.mode !== 'property' || !sort.propertyKey) return records;
	const key = sort.propertyKey;
	const dir = sort.direction === 'desc' ? -1 : 1;
	// Empties always sort last, regardless of direction — an "asc" sort by a
	// mostly-empty property shouldn't bury every populated row on the last page.
	return [...records].sort((a, b) => {
		const av = comparableValue(a.properties?.[key]);
		const bv = comparableValue(b.properties?.[key]);
		if (isEmptyComparable(av) && isEmptyComparable(bv)) return 0;
		if (isEmptyComparable(av)) return 1;
		if (isEmptyComparable(bv)) return -1;
		if (av! < bv!) return -dir;
		if (av! > bv!) return dir;
		return 0;
	});
}

export function projectRecords(records: WorkspaceRecord[], config: ViewConfig): WorkspaceRecord[] {
	return applySort(applyFilters(records, config.filters), config.sort);
}

export function visibleProperties(
	schema: PropertyDefinition[],
	config: ViewConfig
): PropertyDefinition[] {
	if (!config.visibleProperties) return schema;
	const visible = new Set(config.visibleProperties);
	return schema.filter((property) => visible.has(property.key));
}

export interface BoardColumn {
	optionId: string | null; // null = the "No <property>" catch-all column
	label: string;
	color?: string;
	records: WorkspaceRecord[];
}

// Groups by a `select` property's own defined options, in schema order, so
// an option with zero current records still renders as an empty column
// (issue #9: "preserve empty groups ... do not create placeholder records").
// A trailing catch-all column holds records with no value set for this
// property; it is never created for an option itself, only for "no value".
export function groupBySelectProperty(
	records: WorkspaceRecord[],
	property: PropertyDefinition
): BoardColumn[] {
	const options = property.options ?? [];
	const columns: BoardColumn[] = options.map((option) => ({
		optionId: option.id,
		label: option.label,
		color: option.color,
		records: []
	}));
	const unassigned: BoardColumn = { optionId: null, label: `No ${property.label}`, records: [] };

	for (const record of records) {
		const value = record.properties?.[property.key];
		const optionId = value?.type === 'select' ? value.value : undefined;
		const column = columns.find((c) => c.optionId === optionId);
		(column ?? unassigned).records.push(record);
	}

	return [...columns, unassigned];
}

// YYYY-MM-DD portion of a record's date property value, or undefined if the
// property isn't set — used by Calendar to bucket records by day without
// caring about time-of-day precision.
export function dateKeyForRecord(
	record: WorkspaceRecord,
	property: PropertyDefinition
): string | undefined {
	const value = record.properties?.[property.key];
	if (value?.type !== 'date' || !value.value) return undefined;
	return value.value.slice(0, 10);
}
