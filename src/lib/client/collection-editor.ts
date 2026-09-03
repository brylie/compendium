import type * as Y from 'yjs';
import { CURRENT_USER } from './actor';
import {
	addSelectOption,
	createRecord,
	deleteRecord,
	updateCollectionSchema,
	updateRecordProperties,
	ValidationError
} from '$lib/data/records';
import type { PropertyDefinition, PropertyValue, WorkspaceRecord } from '$lib/data/types';

/**
 * Shared row/cell/select-option/field mutation helpers used by every
 * Collection renderer — the embedded Table/Board/Calendar views and the
 * full-page Table route (issue #189). Each wraps a `$lib/data/records.ts`
 * primitive with the "no doc yet" guard every renderer previously
 * reimplemented individually; renderer-specific behavior (Board's
 * pre-seeded column value, Calendar's pre-seeded date) stays in the
 * renderer and calls through to {@link createCollectionRow}.
 */

/** Creates a new row in the given Collection, a no-op if `doc` isn't connected yet. */
export function createCollectionRow(
	doc: Y.Doc | undefined,
	collectionId: string,
	properties: Record<string, PropertyValue> = {}
): WorkspaceRecord | undefined {
	if (!doc) return undefined;
	return createRecord(doc, { parentId: collectionId, properties }, CURRENT_USER);
}

/** Deletes a Collection row, a no-op if `doc` isn't connected yet. */
export function removeCollectionRow(doc: Y.Doc | undefined, recordId: string): void {
	if (!doc) return;
	deleteRecord(doc, recordId);
}

/** Merges the given properties into a Collection row's cells, a no-op if `doc` isn't connected yet. */
export function setCollectionCell(
	doc: Y.Doc | undefined,
	recordId: string,
	properties: Record<string, PropertyValue>
): void {
	if (!doc) return;
	updateRecordProperties(doc, recordId, properties, CURRENT_USER);
}

export type SelectOptionResult =
	| { ok: true; option: { id: string; label: string; color?: string } }
	| { ok: false; error: string };

/**
 * The one path every renderer must use to add a select option — validated,
 * deduped, and palette-colored by `records.ts`'s `addSelectOption`. Before
 * issue #189, Calendar and the full-page Table route each rebuilt the
 * schema by hand instead, silently allowing duplicate, uncolored options.
 */
export function addCollectionSelectOption(
	doc: Y.Doc | undefined,
	collectionId: string,
	propertyKey: string,
	rawLabel: string
): SelectOptionResult {
	if (!doc) return { ok: false, error: 'Not connected yet. Please try again.' };
	try {
		const option = addSelectOption(doc, collectionId, propertyKey, rawLabel);
		return { ok: true, option };
	} catch (err) {
		return {
			ok: false,
			error:
				err instanceof ValidationError ? err.message : 'Could not add the option. Please try again.'
		};
	}
}

/**
 * Appends one field to a Collection's schema — the shared path for Board's
 * "add a select property" and Calendar's "add a date property" first-run
 * prompts, and FieldManagerDialog's "Add field" form.
 */
export function appendCollectionField(
	doc: Y.Doc | undefined,
	collectionId: string,
	currentSchema: PropertyDefinition[],
	field: PropertyDefinition
): void {
	if (!doc) return;
	updateCollectionSchema(doc, collectionId, [...currentSchema, field]);
}
