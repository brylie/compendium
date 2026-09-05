// Shared Collection view-projection semantics — the "smallest shared view
// configuration" issue #9 asks for, scoped to what Table/Board/Calendar
// actually need. This is deliberately a minimal slice of #32's full
// ambition (no named/shareable saved-view artifact, no server-side/
// read-model filtering for MCP's query_collection — see collection-views.md
// §8): pure functions over an already-loaded records array, so Table,
// Board, and Calendar all project the same live Yjs-observed data through
// one path instead of three divergent ones. CollectionViewBlock owns the
// draft-vs-saved distinction (an explicit isDirty flag, with viewConfigsEqual
// below used only to skip a redundant re-sync when nothing actually
// changed); this module stays purely about computing a projection from a
// config, not about who has the authority to persist one.
//
// Per docs/specifications/data-model.md §2, a view "may have configuration
// such as filters, sorts, grouping, visible properties, and a layout-specific
// driving property, but it never copies records, changes their identity, or
// introduces view-specific row fields" — this module only ever reads
// WorkspaceRecord[]/PropertyDefinition[] and returns derived arrays; nothing
// here mutates or persists anything.

import type * as Y from 'yjs';
import { getCollection } from './collection-ops';
import { listRecordsForParent } from './record-ops';
import type {
	CollectionMeta,
	FieldSummaryType,
	PropertyDefinition,
	PropertyType,
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
	FieldSummaryType,
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

/**
 * The one Collection query/projection path Table, Board, Calendar, and any
 * collection_view embed all call — issue #9's "reuse one Collection
 * query/projection path" requirement.
 */
export function getCollectionView(doc: Y.Doc, collectionId: string): CollectionView {
	return {
		collection: getCollection(doc, collectionId),
		records: listRecordsForParent(doc, collectionId)
	};
}

type Comparable = string | number | boolean | undefined;

// Both this and sortComparableValue below deliberately return Comparable's
// full union — extracting a type-appropriate comparable primitive out of a
// PropertyValue is the whole point (a number property compares as a number,
// a checkbox as a boolean, etc.), not something to collapse into one
// return type without losing that.
// eslint-disable-next-line sonarjs/function-return-type
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

/** Keeps only the records matching every filter in a view's filter list; returns `records` unchanged when there are none. */
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

// A `select` value's rank is its position in the field's own `options`
// array — the same order Board's `groupBySelectProperty` already renders
// columns in (data-model.md's canonical Select order). An option id no
// longer present there (deleted, or from a schema the caller doesn't have
// loaded) has no rank — `undefined`, so it falls into the same "empty"
// bucket `isEmptyComparable` already sorts last, matching
// `groupBySelectProperty`'s own catch-all "No <property>" column treatment
// of an unknown id. This is the one canonical Select-order contract every
// renderer (Table/Board/Calendar sort, and Board's column order) shares.
function selectOptionRank(
	property: PropertyDefinition | undefined,
	optionId: string
): number | undefined {
	const index = property?.options?.findIndex((o) => o.id === optionId) ?? -1;
	return index === -1 ? undefined : index;
}

// Like comparableValue, except a `select` value sorts by its configured
// option-array position rather than its opaque, generated option id — a
// plain string comparison of ids bears no relationship to the workflow
// order (e.g. "Backlog → In progress → Done") the field's options define.
// Every other type keeps comparableValue's existing type-appropriate
// comparison unchanged.
// eslint-disable-next-line sonarjs/function-return-type -- see comparableValue above
function sortComparableValue(
	value: PropertyValue | undefined,
	property: PropertyDefinition | undefined
): Comparable {
	if (value?.type === 'select') return selectOptionRank(property, value.value);
	return comparableValue(value);
}

/** Sorts records by a view's configured property sort, always pushing empty values to the end regardless of direction. */
export function applySort(
	records: WorkspaceRecord[],
	schema: PropertyDefinition[],
	sort: ViewSort | undefined
): WorkspaceRecord[] {
	if (sort?.mode !== 'property' || !sort.propertyKey) return records;
	const key = sort.propertyKey;
	const property = schema.find((p) => p.key === key);
	const dir = sort.direction === 'desc' ? -1 : 1;
	// Empties always sort last, regardless of direction — an "asc" sort by a
	// mostly-empty property shouldn't bury every populated row on the last page.
	return [...records].sort((a, b) => {
		const av = sortComparableValue(a.properties?.[key], property);
		const bv = sortComparableValue(b.properties?.[key], property);
		if (isEmptyComparable(av) && isEmptyComparable(bv)) return 0;
		if (isEmptyComparable(av)) return 1;
		if (isEmptyComparable(bv)) return -1;
		if (av! < bv!) return -dir;
		if (av! > bv!) return dir;
		return 0;
	});
}

/** Applies a view's full projection — filters, then sort — to a Collection's records. */
export function projectRecords(
	records: WorkspaceRecord[],
	schema: PropertyDefinition[],
	config: ViewConfig
): WorkspaceRecord[] {
	return applySort(applyFilters(records, config.filters), schema, config.sort);
}

/** Narrows a Collection's schema down to the properties a view is configured to show, or the full schema when no visibility list is set. */
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

/**
 * Groups by a `select` property's own defined options, in schema order, so
 * an option with zero current records still renders as an empty column
 * (issue #9: "preserve empty groups ... do not create placeholder records").
 * A trailing catch-all column holds records with no value set for this
 * property; it is never created for an option itself, only for "no value".
 */
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
		// null, not undefined, to match BoardColumn.optionId's own type —
		// `columns` here never actually contains a null entry (only the
		// separate `unassigned` column below does), so this doesn't change
		// which column a record lands in; it just keeps both sides of the
		// comparison the same nullable type.
		const optionId = value?.type === 'select' ? value.value : null;
		const column = columns.find((c) => c.optionId === optionId);
		(column ?? unassigned).records.push(record);
	}

	return [...columns, unassigned];
}

/**
 * A plain-text rendering of a record's value for the resolved primary field
 * (see resolvePrimaryField in $lib/data/records) — used wherever a record
 * needs a single display string outside its own editable cell (Board/
 * Calendar's card-title aria-labels, the "Move to column" <select> label).
 * Not used for the primary field's own editable rendering, which stays a
 * full PropertyValueCell so every eligible type (not just text) stays
 * directly editable inline.
 */
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

/**
 * YYYY-MM-DD portion of a record's date property value, or undefined if the
 * property isn't set — used by Calendar to bucket records by day without
 * caring about time-of-day precision.
 */
export function dateKeyForRecord(
	record: WorkspaceRecord,
	property: PropertyDefinition
): string | undefined {
	const value = record.properties?.[property.key];
	if (value?.type !== 'date' || !value.value) return undefined;
	return value.value.slice(0, 10);
}

// Structural equality over ViewConfig's own fields (order-insensitive where
// order isn't semantically meaningful) — the dirty/draft-vs-saved check
// CollectionViewBlock uses to decide whether a viewer's local edits differ
// from what's actually persisted (see collection-views.md's draft-view-state
// section). Deliberately not a generic deep-equal: a plain JSON.stringify
// compare would be sensitive to incidental key-insertion-order differences
// between a Yjs-round-tripped object and a freshly-constructed one.
function filtersEqual(a: ViewFilter[] | undefined, b: ViewFilter[] | undefined): boolean {
	const ax = a ?? [];
	const bx = b ?? [];
	return (
		ax.length === bx.length &&
		ax.every(
			(f, i) => f.propertyKey === bx[i].propertyKey && f.op === bx[i].op && f.value === bx[i].value
		)
	);
}

function sortEqual(a: ViewSort | undefined, b: ViewSort | undefined): boolean {
	if (!a && !b) return true;
	if (!a || !b) return false;
	return a.mode === b.mode && a.propertyKey === b.propertyKey && a.direction === b.direction;
}

// visibleProperties/summaries are consumed as sets/maps (visibleProperties
// via visibleProperties() above, summaries by key), not ordered lists — so
// equality here is set/map equality, not array-order equality.
function stringSetEqual(a: string[] | undefined, b: string[] | undefined): boolean {
	const as = new Set(a ?? []);
	const bs = new Set(b ?? []);
	return as.size === bs.size && [...as].every((v) => bs.has(v));
}

function summariesEqual(
	a: Record<string, FieldSummaryType> | undefined,
	b: Record<string, FieldSummaryType> | undefined
): boolean {
	const ae = Object.entries(a ?? {});
	const be = Object.entries(b ?? {});
	return ae.length === be.length && ae.every(([k, v]) => b?.[k] === v);
}

/** Structural equality over a ViewConfig's fields — the dirty/draft-vs-saved check CollectionViewBlock uses to tell whether a viewer's local edits actually differ from what's persisted. */
export function viewConfigsEqual(a: ViewConfig, b: ViewConfig): boolean {
	return (
		filtersEqual(a.filters, b.filters) &&
		sortEqual(a.sort, b.sort) &&
		stringSetEqual(a.visibleProperties, b.visibleProperties) &&
		a.groupBy === b.groupBy &&
		summariesEqual(a.summaries, b.summaries)
	);
}

/**
 * Per-member diff between the config a viewer started editing from (`base`)
 * and their local draft (`next`) — only the members that actually changed
 * are included, using the same per-field equality as viewConfigsEqual rather
 * than a reference/JSON compare. CollectionViewBlock passes this straight to
 * patchRecordViewConfig on Save so a viewer's edit to (say) only `filters`
 * never overwrites a `sort` change someone else saved in the meantime with a
 * stale copy of it — see records.ts's patchRecordViewConfig doc comment and
 * issue #71. A member reset back to `undefined` (e.g. clearing groupBy) is
 * still included, so patchRecordViewConfig clears it rather than leaving the
 * old value in place.
 *
 * visibleProperties needs its own equality rather than stringSetEqual
 * directly: `undefined` (show every property) and `[]` (show none) are both
 * empty sets but mean opposite things, so a transition between them must
 * still produce a patch even though stringSetEqual alone would call them equal.
 */
export function diffViewConfig(base: ViewConfig, next: ViewConfig): Partial<ViewConfig> {
	const patch: Partial<ViewConfig> = {};
	if (!filtersEqual(base.filters, next.filters)) patch.filters = next.filters;
	if (!sortEqual(base.sort, next.sort)) patch.sort = next.sort;
	const visibilityChanged =
		base.visibleProperties === undefined || next.visibleProperties === undefined
			? base.visibleProperties !== next.visibleProperties
			: !stringSetEqual(base.visibleProperties, next.visibleProperties);
	if (visibilityChanged) patch.visibleProperties = next.visibleProperties;
	if (base.groupBy !== next.groupBy) patch.groupBy = next.groupBy;
	if (!summariesEqual(base.summaries, next.summaries)) patch.summaries = next.summaries;
	return patch;
}

// Which aggregations a property's type offers in Table's per-column footer
// (issue #32's "type-appropriate field summaries") — mirrors Notion/Airtable's
// footer-summary picker, scoped to the property types this schema has.
const NUMERIC_SUMMARIES: FieldSummaryType[] = [
	'none',
	'count_all',
	'count_values',
	'count_empty',
	'sum',
	'average',
	'min',
	'max'
];
const DATE_SUMMARIES: FieldSummaryType[] = [
	'none',
	'count_all',
	'count_values',
	'count_empty',
	'earliest',
	'latest'
];
const CHECKBOX_SUMMARIES: FieldSummaryType[] = ['none', 'count_all', 'checked', 'unchecked'];
const GENERIC_SUMMARIES: FieldSummaryType[] = ['none', 'count_all', 'count_values', 'count_empty'];

/** Which summary aggregations are offered for a property's type in Table's per-column footer picker. */
export function summaryOptionsForType(type: PropertyType): FieldSummaryType[] {
	switch (type) {
		case 'number':
			return NUMERIC_SUMMARIES;
		case 'date':
			return DATE_SUMMARIES;
		case 'checkbox':
			return CHECKBOX_SUMMARIES;
		case 'text':
		case 'select':
		case 'relation':
			return GENERIC_SUMMARIES;
	}
}

/** Human-readable label for a field summary type, for display in the footer's summary picker. */
export function fieldSummaryLabel(type: FieldSummaryType): string {
	switch (type) {
		case 'none':
			return 'None';
		case 'count_all':
			return 'Count all';
		case 'count_values':
			return 'Count values';
		case 'count_empty':
			return 'Count empty';
		case 'sum':
			return 'Sum';
		case 'average':
			return 'Average';
		case 'min':
			return 'Min';
		case 'max':
			return 'Max';
		case 'earliest':
			return 'Earliest';
		case 'latest':
			return 'Latest';
		case 'checked':
			return 'Checked';
		case 'unchecked':
			return 'Unchecked';
	}
}

/**
 * Computed over whatever record set the caller passes — Table passes its
 * already-filtered/sorted projection, so a summary reflects what's actually
 * visible, the same convention Notion/Airtable use for a footer aggregation.
 */
export function computeFieldSummary(
	records: WorkspaceRecord[],
	property: PropertyDefinition,
	type: FieldSummaryType
): string {
	if (type === 'none') return '';
	const values = records.map((r) => r.properties?.[property.key]);
	const present = values.filter((v) => !isEmptyComparable(comparableValue(v)));

	switch (type) {
		case 'count_all':
			return String(records.length);
		case 'count_values':
			return String(present.length);
		case 'count_empty':
			return String(records.length - present.length);
		case 'sum': {
			const nums = present.filter((v) => v?.type === 'number').map((v) => v!.value as number);
			return String(nums.reduce((a, b) => a + b, 0));
		}
		case 'average': {
			const nums = present.filter((v) => v?.type === 'number').map((v) => v!.value as number);
			if (nums.length === 0) return '';
			const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
			return String(Math.round(avg * 100) / 100);
		}
		case 'min': {
			const nums = present.filter((v) => v?.type === 'number').map((v) => v!.value as number);
			return nums.length ? String(Math.min(...nums)) : '';
		}
		case 'max': {
			const nums = present.filter((v) => v?.type === 'number').map((v) => v!.value as number);
			return nums.length ? String(Math.max(...nums)) : '';
		}
		case 'earliest': {
			// ISO 8601 date strings sort chronologically under plain lexical
			// order (zero-padded YYYY-MM-DD), so localeCompare here produces
			// the identical result a bare .sort() already did — spelled out
			// explicitly rather than relying on the default comparator, which
			// is only lexically-safe for this specific string format.
			const dates = present
				.filter((v) => v?.type === 'date')
				.map((v) => v!.value as string)
				.sort((a, b) => a.localeCompare(b));
			return dates[0] ?? '';
		}
		case 'latest': {
			const dates = present
				.filter((v) => v?.type === 'date')
				.map((v) => v!.value as string)
				.sort((a, b) => a.localeCompare(b));
			return dates[dates.length - 1] ?? '';
		}
		case 'checked': {
			const checked = values.filter((v) => v?.type === 'checkbox' && v.value).length;
			return String(checked);
		}
		case 'unchecked': {
			const checked = values.filter((v) => v?.type === 'checkbox' && v.value).length;
			return String(records.length - checked);
		}
	}
}
