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
import type {
	CollectionMeta,
	PropertyDefinition,
	PropertyValue,
	ViewConfig,
	ViewFilter,
	ViewSort,
	WorkspaceRecord
} from './types';

// Re-exported so existing call sites (ViewToolbar.svelte etc.) can keep
// importing view-config types from '$lib/data/views' — the canonical
// definitions now live in types.ts alongside EmbeddedViewConfig, since a
// collection_view block's persisted config needs them too.
export type {
	EmbeddedViewConfig,
	SortDirection,
	ViewConfig,
	ViewFilter,
	ViewFilterOp,
	ViewSort,
	ViewType
} from './types';

export interface CollectionView {
	collection: CollectionMeta | undefined;
	records: WorkspaceRecord[];
}

// The one Collection query/projection path Table, Board, Calendar, and any
// collection_view embed all call — issue #9's "reuse one Collection
// query/projection path" requirement.
export function getCollectionView(doc: Y.Doc, collectionId: string): CollectionView {
	return {
		collection: getCollection(doc, collectionId),
		records: listRecordsForParent(doc, collectionId)
	};
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

// A plain-text rendering of a record's value for the resolved primary field
// (see resolvePrimaryField in $lib/data/records) — used wherever a record
// needs a single display string outside its own editable cell (Board/
// Calendar's card-title aria-labels, the "Move to column" <select> label).
// Not used for the primary field's own editable rendering, which stays a
// full PropertyValueCell so every eligible type (not just text) stays
// directly editable inline.
export function primaryFieldDisplayValue(
	value: PropertyValue | undefined,
	property: PropertyDefinition | undefined
): string {
	if (!value || !property) return '';
	switch (value.type) {
		case 'text':
			return value.value;
		case 'number':
			return String(value.value);
		case 'date':
			return value.value;
		case 'checkbox':
			return value.value ? 'Checked' : '';
		case 'select':
			return property.options?.find((o) => o.id === value.value)?.label ?? '';
		case 'relation':
			return '';
	}
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
