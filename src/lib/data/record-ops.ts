import * as Y from 'yjs';
import { generateKeyBetween } from 'fractional-indexing';
import { nanoid } from 'nanoid';
import type {
	ActorId,
	BlockType,
	CalloutStyle,
	ChildPagesDepth,
	EmbeddedViewConfig,
	ParentKind,
	PropertyDefinition,
	PropertyValue,
	RichText,
	ViewConfig,
	WorkspaceRecord
} from './types';
import { applyRichTextToYText, yTextToRichText } from './richtext';
import { type TypedYMap, typedYMap } from './yjs-typed';
import {
	type RecordYShape,
	PROP_PREFIX,
	collectionsMap,
	documentsMap,
	recordsMap,
	setPropertyValue
} from './yjs-shapes';
import {
	applyOptionalBlockFields,
	migrateLegacyViewConfig,
	readViewConfig,
	sanitizeCalloutStyle,
	writeViewConfig,
	writeViewConfigField
} from './view-config';
import { NotFoundError, ValidationError } from './errors';

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
		viewConfig: readViewConfig(yrecord),
		calloutStyle: yrecord.get('calloutStyle'),
		childPagesDepth: yrecord.get('childPagesDepth'),
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
	calloutStyle?: CalloutStyle; // for callout blocks
	childPagesDepth?: ChildPagesDepth; // for child_pages blocks
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
			applyOptionalBlockFields(yrecord, input);
		} else {
			yrecord.set('isCollectionRow', true);
			const schema = collectionsMap(doc).get(input.parentId)?.get('schema') ?? [];
			const properties = applyDefaultSelectValues(schema, input.properties);
			for (const [key, value] of Object.entries(properties ?? {})) {
				setPropertyValue(yrecord, key, value);
			}
		}

		recordsMap(doc).set(id, yrecord.raw);
		siblingIds.insert(insertAt, [id]);

		return readRecord(yrecord);
	});
}

// Fills in a `select` field's configured default (issue #100) for every
// property the caller didn't already supply a value for — read from the
// Collection's schema inside createRecord's own transaction, not a
// caller-supplied snapshot, so it can never seed from a schema that's since
// changed underneath a concurrent field edit. A caller's own value for that
// key always wins (Board's "+ Add card"/Calendar's day-cell "+" pre-seed the
// grouping/date field this same way — an explicit value must never be
// overridden by a schema default), and a defaultOptionId that's gone stale
// (its option was since deleted, which normally clears it via
// deleteSelectOption, but this stays defensive against any schema written by
// another path) is silently skipped rather than seeding a dangling option id.
function applyDefaultSelectValues(
	schema: PropertyDefinition[],
	properties: Record<string, PropertyValue> | undefined
): Record<string, PropertyValue> | undefined {
	const defaults = schema.filter(
		(p): p is PropertyDefinition & { defaultOptionId: string } =>
			p.type === 'select' &&
			p.defaultOptionId !== undefined &&
			properties?.[p.key] === undefined &&
			(p.options ?? []).some((o) => o.id === p.defaultOptionId)
	);
	if (defaults.length === 0) return properties;
	const next = { ...properties };
	for (const property of defaults) {
		next[property.key] = { type: 'select', value: property.defaultOptionId };
	}
	return next;
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

/** Sets (or, given `null`, clears back to the neutral default) a callout block's style — one of the four presets, or a fully custom icon+color (issue #42). Whole-value, like `setRecordChecked`/`setRecordCollapsed`: a style is always chosen as one coherent unit via its own picker UI, never edited member-by-member the way `viewConfig` is, so there's no per-member merge concern to design around here. */
export function setRecordCalloutStyle(
	doc: Y.Doc,
	id: string,
	calloutStyle: CalloutStyle | null,
	actor: ActorId
): void {
	const yrecord = recordsMap(doc).get(id);
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);
	doc.transact(() => {
		if (calloutStyle === null) yrecord.raw.delete('calloutStyle');
		else yrecord.set('calloutStyle', sanitizeCalloutStyle(calloutStyle));
		yrecord.set('lastEditedBy', actor);
		yrecord.set('lastEditedAt', Date.now());
	});
}

/**
 * Reconfigures a child_pages block's target Document and/or nesting depth
 * (issue #43) — `referencedRecordId: null` clears an explicit target back to
 * the default ("the current Document"); `depth: null` clears back to the
 * default depth (1, immediate children only). Either field, passed
 * `undefined`, is left untouched, so a picker can update just the one the
 * viewer actually changed. Like setRecordCalloutStyle, this is a direct
 * record mutation with no MCP write path — write_record's referencedRecordId
 * support is page_link-only (mcp-tools.md); an agent configures a
 * child_pages block's target/depth only at creation time, via
 * create_record's own referencedRecordId/childPagesDepth fields.
 */
export function setRecordChildPagesConfig(
	doc: Y.Doc,
	id: string,
	config: { referencedRecordId?: string | null; depth?: ChildPagesDepth | null },
	actor: ActorId
): void {
	const yrecord = recordsMap(doc).get(id);
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);
	// This bypasses the service layer (a direct-UI-mutation, like
	// setRecordCalloutStyle) so its own validation is the only guard —
	// without it, a caller could retarget an unrelated block type (e.g.
	// overwrite a page_link's referencedRecordId) or persist a depth
	// (NaN/fraction/negative/unsafe-integer) that would silently corrupt
	// resolveChildPages' output.
	if (yrecord.get('blockType') !== 'child_pages') {
		throw new ValidationError(`Record ${id} is not a child_pages block`);
	}
	if (
		config.depth !== undefined &&
		config.depth !== null &&
		config.depth !== 'unlimited' &&
		!(Number.isSafeInteger(config.depth) && config.depth >= 1)
	) {
		throw new ValidationError('childPagesDepth must be a positive integer or "unlimited"');
	}
	doc.transact(() => {
		if (config.referencedRecordId === null) yrecord.raw.delete('referencedRecordId');
		else if (config.referencedRecordId !== undefined) {
			yrecord.set('referencedRecordId', config.referencedRecordId);
		}
		if (config.depth === null) yrecord.raw.delete('childPagesDepth');
		else if (config.depth !== undefined) yrecord.set('childPagesDepth', config.depth);
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
 * Replaces a collection_view block's entire view type + filters/sort/
 * visible-properties/grouping-property config — for an outright reconfigure
 * (a brand new embed, or switching its view type/target), where every member
 * is legitimately being reset together. For an in-place edit to just one or
 * two members (e.g. ViewToolbar's filter or sort editor), use
 * patchRecordViewConfig instead so a concurrent edit to a different member
 * isn't silently overwritten by this call's stale copy of it (issue #71) —
 * each member is still stored as its own `viewConfig:<field>` Y.Map entry
 * (see view-config.ts), so per-member merge still applies between this call
 * and any concurrent patchRecordViewConfig call.
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
		writeViewConfig(yrecord, viewConfig);
		yrecord.set('lastEditedBy', actor);
		yrecord.set('lastEditedAt', Date.now());
	});
}

/**
 * Merges a partial set of viewConfig member changes into a collection_view
 * block's config (per-member LWW via Y.Map, mirroring updateRecordProperties
 * for Collection row properties) — a member named in `patch` (even as
 * `undefined`, to clear it) is written; every other member is left exactly
 * as-is. This is what lets one actor's filter edit and another actor's
 * concurrent sort edit both survive instead of one clobbering the other
 * (issue #71) — the caller (CollectionViewBlock.svelte) is responsible for
 * diffing its local draft against the config it started editing from and
 * passing only the members that actually changed.
 *
 * Deliberately `Partial<ViewConfig>`, not `Partial<EmbeddedViewConfig>`:
 * `viewType` can't be patched here. Clearing it would make readViewConfig
 * report the record as unconfigured while its other members lingered
 * orphaned in prefixed entries, and changing it wouldn't reset the
 * now-previous view type's dependent members (e.g. a Board's `groupBy`
 * surviving a switch to Calendar). Use setRecordViewConfig for that — an
 * outright reconfigure, not a member-level edit. The type already blocks
 * `viewType` at compile time for a typed caller; the explicit check below
 * enforces the same rule at runtime, in case an untyped caller or an unsafe
 * cast gets one into `patch` anyway.
 */
export function patchRecordViewConfig(
	doc: Y.Doc,
	id: string,
	patch: Partial<ViewConfig>,
	actor: ActorId
): void {
	if ('viewType' in patch) {
		throw new ValidationError(
			'patchRecordViewConfig cannot change viewType — use setRecordViewConfig instead'
		);
	}
	const yrecord = recordsMap(doc).get(id);
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);
	doc.transact(() => {
		migrateLegacyViewConfig(yrecord);
		for (const field of Object.keys(patch) as (keyof ViewConfig)[]) {
			writeViewConfigField(yrecord, field, patch[field]);
		}
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
