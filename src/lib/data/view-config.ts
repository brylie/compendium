import type {
	CalloutStyle,
	ChildPagesDepth,
	EmbeddedViewConfig,
	FieldSummaryType,
	ViewFilter,
	ViewSort,
	ViewType
} from './types';
import { DEFAULT_CUSTOM_CALLOUT_COLOR, isValidHexColor } from './callout-style';
import type { TypedYMap } from './yjs-typed';
import type { RecordYShape } from './yjs-shapes';

// A collection_view block's viewConfig members are stored as individual
// `viewConfig:<field>` entries rather than one JSON blob, so an edit to
// `filters` and a concurrent edit to `sort` merge independently instead of
// one whole-value write silently dropping the other (issue #71).
const VIEW_CONFIG_PREFIX = 'viewConfig:';

// A collection_view block created before per-member storage (#183) has its
// whole EmbeddedViewConfig under this single legacy key instead. Reads fall
// back to it (readViewConfig below) so an existing embed doesn't suddenly
// look unconfigured; any write to the record's viewConfig upgrades it into
// the prefixed entries and removes it (migrateLegacyViewConfig below) — a
// one-time, lazy per-record migration on next touch rather than a separate
// migration pass, since Phase 0 is single-tenant with few such records.
const LEGACY_VIEW_CONFIG_KEY = 'viewConfig';

/** Reads one collection_view block's viewConfig back out of its `viewConfig:<field>` entries, falling back read-only to a pre-#183 legacy whole-value key (see LEGACY_VIEW_CONFIG_KEY above), or undefined if it isn't configured at all. */
export function readViewConfig(yrecord: TypedYMap<RecordYShape>): EmbeddedViewConfig | undefined {
	const viewType = yrecord.raw.get(VIEW_CONFIG_PREFIX + 'viewType') as ViewType | undefined;
	if (!viewType) {
		return yrecord.raw.get(LEGACY_VIEW_CONFIG_KEY) as EmbeddedViewConfig | undefined;
	}

	const filters = yrecord.raw.get(VIEW_CONFIG_PREFIX + 'filters') as ViewFilter[] | undefined;
	const sort = yrecord.raw.get(VIEW_CONFIG_PREFIX + 'sort') as ViewSort | undefined;
	const visibleProperties = yrecord.raw.get(VIEW_CONFIG_PREFIX + 'visibleProperties') as
		string[] | undefined;
	const groupBy = yrecord.raw.get(VIEW_CONFIG_PREFIX + 'groupBy') as string | undefined;
	const summaries = yrecord.raw.get(VIEW_CONFIG_PREFIX + 'summaries') as
		Record<string, FieldSummaryType> | undefined;

	return {
		viewType,
		...(filters !== undefined && { filters }),
		...(sort !== undefined && { sort }),
		...(visibleProperties !== undefined && { visibleProperties }),
		...(groupBy !== undefined && { groupBy }),
		...(summaries !== undefined && { summaries })
	};
}

/** Writes (or, given `undefined`, clears) one viewConfig member's `viewConfig:<field>` entry. */
export function writeViewConfigField<K extends keyof EmbeddedViewConfig>(
	yrecord: TypedYMap<RecordYShape>,
	field: K,
	value: EmbeddedViewConfig[K] | undefined
): void {
	if (value === undefined) yrecord.raw.delete(VIEW_CONFIG_PREFIX + field);
	else yrecord.raw.set(VIEW_CONFIG_PREFIX + field, value);
}

/** Writes every member of a full viewConfig, clearing any member absent from it — for a fresh record or an outright reconfigure (new embed target / view type change), not a partial in-place edit (use patchRecordViewConfig for that). Also clears any pre-#183 legacy whole-value entry, so a full replace always leaves the record fully migrated. */
export function writeViewConfig(
	yrecord: TypedYMap<RecordYShape>,
	config: EmbeddedViewConfig
): void {
	writeViewConfigField(yrecord, 'viewType', config.viewType);
	writeViewConfigField(yrecord, 'filters', config.filters);
	writeViewConfigField(yrecord, 'sort', config.sort);
	writeViewConfigField(yrecord, 'visibleProperties', config.visibleProperties);
	writeViewConfigField(yrecord, 'groupBy', config.groupBy);
	writeViewConfigField(yrecord, 'summaries', config.summaries);
	yrecord.raw.delete(LEGACY_VIEW_CONFIG_KEY);
}

/**
 * One-time upgrade of a pre-#183 record's legacy whole-value viewConfig into
 * the prefixed per-member entries — a no-op once already migrated (or if the
 * record was never configured). Called at the start of any *partial*
 * viewConfig write (patchRecordViewConfig, and the two field-repair
 * functions in collection-ops.ts), so that write doesn't get silently
 * shadowed by (or lost under) a legacy value readViewConfig would otherwise
 * keep falling back to. A full replace (writeViewConfig/setRecordViewConfig)
 * doesn't need this: it already overwrites every prefixed field and clears
 * the legacy key itself.
 */
export function migrateLegacyViewConfig(yrecord: TypedYMap<RecordYShape>): void {
	if (yrecord.raw.has(VIEW_CONFIG_PREFIX + 'viewType')) return;
	const legacy = yrecord.raw.get(LEGACY_VIEW_CONFIG_KEY) as EmbeddedViewConfig | undefined;
	if (!legacy) return;
	writeViewConfig(yrecord, legacy);
}

/**
 * A custom CalloutStyle's color comes from an `<input type="color">` in the
 * normal path, but nothing at the type level stops a malformed value from
 * reaching either persistence call below — falls back to the same neutral
 * default the picker itself starts from, rather than persisting garbage that
 * deriveCustomCalloutColors' hex parsing would later choke on.
 */
export function sanitizeCalloutStyle(calloutStyle: CalloutStyle): CalloutStyle {
	if (calloutStyle.kind === 'custom' && !isValidHexColor(calloutStyle.color)) {
		return { ...calloutStyle, color: DEFAULT_CUSTOM_CALLOUT_COLOR };
	}
	return calloutStyle;
}

/**
 * Sets the checked/collapsed/referencedRecordId/viewConfig/calloutStyle/
 * childPagesDepth group of block-only optional fields — shared by
 * createRecord and copyRecordVerbatim, which otherwise each repeat the same
 * conditionals inline (pushing both functions' own cognitive complexity over
 * the lint threshold once calloutStyle was the fifth).
 */
export function applyOptionalBlockFields(
	yrecord: TypedYMap<RecordYShape>,
	fields: {
		checked?: boolean;
		collapsed?: boolean;
		referencedRecordId?: string;
		viewConfig?: EmbeddedViewConfig;
		calloutStyle?: CalloutStyle;
		childPagesDepth?: ChildPagesDepth;
	}
): void {
	if (fields.checked !== undefined) yrecord.set('checked', fields.checked);
	if (fields.collapsed !== undefined) yrecord.set('collapsed', fields.collapsed);
	if (fields.referencedRecordId) yrecord.set('referencedRecordId', fields.referencedRecordId);
	if (fields.viewConfig) writeViewConfig(yrecord, fields.viewConfig);
	if (fields.calloutStyle) yrecord.set('calloutStyle', sanitizeCalloutStyle(fields.calloutStyle));
	if (fields.childPagesDepth !== undefined) {
		yrecord.set('childPagesDepth', fields.childPagesDepth);
	}
}
