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
import { blockCapabilitiesFor } from './block-capabilities';
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

/**
 * Resolves what kind of thing `parentId` names — a Document, a Collection,
 * or (issue #148) a container record (a `columns`/`column` block, the only
 * record types created with their own `recordIds` array; see createRecord).
 * A record only counts as a 'record'-kind parent once that array actually
 * exists on it — this is the data-shape check every other parent-resolving
 * function in this module keys off, not a hardcoded blockType allowlist.
 */
export function parentKindOf(doc: Y.Doc, parentId: string): ParentKind | undefined {
	if (documentsMap(doc).has(parentId)) return 'document';
	if (collectionsMap(doc).has(parentId)) return 'collection';
	if (recordsMap(doc).get(parentId)?.get('recordIds')) return 'record';
	return undefined;
}

/**
 * True when `childId` still authoritatively belongs to `parentId` — i.e. its
 * own live `parentId` field agrees, not just its presence in `parentId`'s
 * sibling/child array. A concurrent cross-container `moveRecordToParent`
 * (issue #148) can leave the *losing* container with a stale array entry for
 * a record whose `parentId` now points elsewhere (two different Y.Arrays
 * each independently accept their own insert — see `listRecordsForParent`'s
 * doc comment) — every recursive or projecting consumer of a container's
 * `recordIds` must treat that stale entry as gone, not as a real child, or
 * it can act on (render, delete, migrate) a record that no longer belongs to
 * it. Exported for `migration-copy.ts`'s own recursive copy to share.
 */
export function isAuthoritativeChild(doc: Y.Doc, parentId: string, childId: string): boolean {
	return recordsMap(doc).get(childId)?.get('parentId') === parentId;
}

function parentRecordIds(doc: Y.Doc, parentId: string, kind: ParentKind): Y.Array<string> {
	if (kind === 'document') {
		return documentsMap(doc).get(parentId)!.get('recordIds')!;
	}
	if (kind === 'record') {
		return recordsMap(doc).get(parentId)!.get('recordIds')!;
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

/**
 * Walks a record's `parentId` chain up to its owning Document or Collection
 * — needed because a container block (columns/column, issue #148) can
 * itself be a valid `parentId`, but access-token allowlists and the
 * record-index read model (persistence.md §2) are always keyed by
 * Document/Collection id (`mcp-tools.md`), never by an arbitrary nested
 * record id. Returns `id` unchanged once it no longer resolves to a record
 * at all (i.e. it's already a Document/Collection id, or unknown) — a no-op
 * for every pre-#148 call site, where `id` was always already top-level.
 * `guard` bounds the walk against a corrupted/cyclic `parentId` chain (real
 * nesting is at most a couple of levels deep). A pure data-layer primitive
 * (no permission logic of its own) shared by services/permissions.ts and
 * server/record-index-observer.ts.
 */
export function resolveOwningParentId(doc: Y.Doc, id: string, guard = 50): string {
	let current = id;
	for (let i = 0; i < guard; i++) {
		const record = getRecord(doc, current);
		if (!record) return current;
		current = record.parentId;
	}
	return current;
}

/** Every record id currently in this shard's `Y.Doc`, in no particular order — used by the record-index projection's full rebuild (persistence.md §2). */
export function listAllRecordIds(doc: Y.Doc): string[] {
	const ids: string[] = [];
	recordsMap(doc).forEach((_entry, id) => ids.push(id));
	return ids;
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
		fullWidth: yrecord.get('fullWidth'),
		childRecordIds: yrecord.get('recordIds')?.toArray(),
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
	fullWidth?: boolean; // opts out of the content-width column (issue #150)
}

// Extracted from createRecord purely to keep its own cognitive complexity
// down — this is its entire "parent is a Document or a container record"
// branch (the row-properties branch is the only sibling left inline there).
function applyDocumentKindFields(
	yrecord: TypedYMap<RecordYShape>,
	blockType: BlockType,
	input: CreateRecordInput,
	siblingIds: Y.Array<string>
): void {
	const isContainer = blockCapabilitiesFor(blockType).isContainer;
	yrecord.set('blockType', blockType);
	// A container never holds its own free-form text — its content lives
	// entirely in its children (data-model.md §3.1) — so unlike every other
	// Document-kind record it gets no content Y.Text at all: nothing in the
	// UI ever mounts a BlockEditor against a columns/column record directly,
	// and get_document's markdown for a columns block already comes
	// entirely from its columns' children, not from any value here. Without
	// this, a write_record markdown write to a columns/column id would
	// silently vanish from both — writeRecord (services/records.ts) rejects
	// that case outright.
	if (!isContainer) yrecord.set('content', new Y.Text());
	applyOptionalBlockFields(yrecord, input);
	if (isContainer) {
		// A columns/column block always carries its own child-ordering array
		// from the moment it exists — that's what makes it a valid `parentId`
		// target immediately (see parentKindOf above), with no separate
		// "initialize container" step a caller could forget.
		yrecord.set('recordIds', new Y.Array<string>());
	}
	if (blockType === 'column' && siblingIds.length >= MAX_COLUMN_COUNT) {
		throw new ValidationError(`A columns block can hold at most ${MAX_COLUMN_COUNT} columns.`);
	}
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

		let blockType: BlockType | undefined;
		if (kind === 'document' || kind === 'record') {
			blockType = input.blockType ?? 'paragraph';
			applyDocumentKindFields(yrecord, blockType, input, siblingIds);
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

		// A column is never left with nothing to click into — whether it was
		// just created bare via create_record (an MCP agent adding a column)
		// or as one of createColumnsBlock's initial set below, it always
		// gets one empty paragraph seeded in the same transaction. Re-read
		// after seeding (not the yrecord snapshot from just above) so the
		// returned record's own childRecordIds already reflects it.
		if (blockType === 'column') {
			createRecord(doc, { parentId: id, blockType: 'paragraph' }, actor);
		}
		return readRecord(yrecord);
	});
}

// A columns block's column count invariant (issue #148, block-capability-
// contract.md) — enforced at every mutation path that can change it
// (createColumnsBlock's initial count, createRecord's own per-column-add
// check above, and deleteRecord's per-column-remove check below), not just
// at the UI layer, so a direct data-layer or MCP caller can't bypass it the
// way the UI's own hidden +/- buttons alone would only discourage.
export const MIN_COLUMN_COUNT = 2;
export const MAX_COLUMN_COUNT = 6;

/**
 * Creates a `columns` container block plus `columnCount` (default 2, issue
 * #148) empty `column` children beneath it — the only way a `columns` block
 * is ever created, so it can never end up with zero columns. `columnCount`
 * isn't itself persisted anywhere: a columns block's actual column count is
 * always just its live `childRecordIds.length`, the same "derived, not
 * stored" precedent childPages' resolved listing already establishes.
 */
export function createColumnsBlock(
	doc: Y.Doc,
	input: { id?: string; parentId: string; afterRecordId?: string },
	actor: ActorId,
	columnCount = 2
): WorkspaceRecord {
	// Validated up front, before the transaction opens — createRecord's own
	// per-add check below would otherwise let this loop create up to
	// MAX_COLUMN_COUNT columns before throwing on the (MAX+1)th, leaving a
	// half-sized columns block committed instead of failing cleanly with
	// nothing created.
	if (
		!Number.isSafeInteger(columnCount) ||
		columnCount < MIN_COLUMN_COUNT ||
		columnCount > MAX_COLUMN_COUNT
	) {
		throw new ValidationError(
			`columnCount must be an integer between ${MIN_COLUMN_COUNT} and ${MAX_COLUMN_COUNT}.`
		);
	}
	return doc.transact(() => {
		const columnsRecord = createRecord(
			doc,
			{
				id: input.id,
				parentId: input.parentId,
				afterRecordId: input.afterRecordId,
				blockType: 'columns'
			},
			actor
		);
		for (let i = 0; i < columnCount; i++) {
			createRecord(doc, { parentId: columnsRecord.id, blockType: 'column' }, actor);
		}
		return getRecord(doc, columnsRecord.id)!;
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

/** Toggles a block's full-width display (issue #150) — opts it out of the page's content-width column so it spans the full document canvas instead. Whole-value, like `setRecordChecked`/`setRecordCollapsed`. */
export function setRecordFullWidth(
	doc: Y.Doc,
	id: string,
	fullWidth: boolean,
	actor: ActorId
): void {
	const yrecord = recordsMap(doc).get(id);
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);
	doc.transact(() => {
		yrecord.set('fullWidth', fullWidth);
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

// Neither of detachSyncedBlock's blockType/content copy steps below is safe
// for a container (blockCapabilitiesFor(...).isContainer): it has no content
// Y.Text at all (createRecord never allocates one — see
// applyDocumentKindFields) and, more importantly, needs its own
// childRecordIds array to be a valid columns/column block at all — blindly
// copying just the blockType would produce a broken container with no
// children. The "Set target ID" dialog accepts any pasted record id with no
// kind check, so this has to be guarded here rather than assumed away.
function isUndetachableSourceBlockType(blockType: BlockType): boolean {
	return blockCapabilitiesFor(blockType).isContainer;
}

/**
 * Resolves a synced_block's referencedRecordId to the first *non*-synced_block
 * record in the chain — a synced_block can (unusually, but the "Set target
 * ID" dialog doesn't prevent it) point at another synced_block, and copying
 * that wrapper's own blockType/content as-is would just produce a second
 * unconfigured synced_block rather than the real independent content detach
 * is supposed to produce. Bounded by `seen` against a reference cycle (A
 * pointing at B pointing back at A); returns undefined once the chain
 * breaks, cycles, or the pasted id never resolved to anything — same as an
 * ordinary broken reference, which detachSyncedBlock already handles by
 * falling back to an empty paragraph.
 */
function resolveSyncedBlockSource(doc: Y.Doc, id: string): WorkspaceRecord | undefined {
	const seen = new Set<string>();
	let current = getRecord(doc, id);
	while (current?.blockType === 'synced_block') {
		if (seen.has(current.id) || !current.referencedRecordId) return undefined;
		seen.add(current.id);
		current = getRecord(doc, current.referencedRecordId);
	}
	return current;
}

/**
 * Breaks a synced_block instance out of its sync relationship (issue #153's
 * "detach to independent copy") — bakes the source's *current* blockType,
 * content, and full optional-field configuration (checked/collapsed/
 * calloutStyle/referencedRecordId/viewConfig/childPagesDepth/fullWidth, the
 * same set duplicateRecordInto copies for an ordinary record duplication)
 * into the instance's own (previously unused — see createRecord's content
 * Y.Text, always allocated for a non-container block regardless of
 * blockType) fields, then clears the *former* sync-target referencedRecordId
 * (re-set immediately after if the source itself carries its own, e.g. a
 * page_link/collection_view/child_pages source). The instance keeps its own
 * id, so anything already pointing at it (a copied block link, an undo
 * entry) keeps working; only its relationship to the former source is gone,
 * with no reference left to go stale if that source is later edited or
 * deleted.
 *
 * A source that no longer resolves (deleted, never set, a reference cycle,
 * or — see isUndetachableSourceBlockType above — a columns/column
 * container this function can't safely copy) detaches to an empty paragraph
 * rather than throwing: "detach" is meant as an escape hatch, including from
 * a synced_block whose target is already broken.
 */
export function detachSyncedBlock(doc: Y.Doc, id: string, actor: ActorId): WorkspaceRecord {
	const yrecord = recordsMap(doc).get(id);
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);
	if (yrecord.get('blockType') !== 'synced_block') {
		throw new ValidationError('detachSyncedBlock can only be called on a synced_block record.');
	}

	const sourceId = yrecord.get('referencedRecordId');
	const resolved = sourceId ? resolveSyncedBlockSource(doc, sourceId) : undefined;
	const source =
		resolved && !isUndetachableSourceBlockType(resolved.blockType ?? 'paragraph')
			? resolved
			: undefined;
	const sourceText = source ? getRecordYText(doc, source.id) : undefined;

	return doc.transact(() => {
		yrecord.set('blockType', source?.blockType ?? 'paragraph');
		// Cleared unconditionally, then re-set below by applyOptionalBlockFields
		// if the source itself carries one (a page_link/collection_view/
		// child_pages source) — otherwise this detach must not leave the
		// instance's *former* sync-target reference behind.
		yrecord.delete('referencedRecordId');
		yrecord.set('lastEditedBy', actor);
		yrecord.set('lastEditedAt', Date.now());
		// Same field set duplicateRecordInto passes to createRecord for a full
		// record copy — reused here so detaching from a page_link/
		// collection_view/child_pages source also carries over the
		// configuration that makes that block type actually work (its
		// referencedRecordId/viewConfig/childPagesDepth), not just its
		// blockType label (CodeRabbit finding on this PR: detaching such a
		// source previously produced an unconfigured block of that type).
		if (source) {
			applyOptionalBlockFields(yrecord, {
				checked: source.checked,
				collapsed: source.collapsed,
				referencedRecordId: source.referencedRecordId,
				viewConfig: source.viewConfig,
				calloutStyle: source.calloutStyle,
				childPagesDepth: source.childPagesDepth,
				fullWidth: source.fullWidth
			});
		}

		const ownText = yrecord.get('content');
		if (sourceText && ownText) applyRichTextToYText(ownText, yTextToRichText(sourceText));

		return readRecord(yrecord);
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

/**
 * Recursive body of deleteRecord — a container block's (columns/column,
 * issue #148) own children have no independent existence once it's gone, so
 * they're deleted first, depth-first, before the container's own entry and
 * its place in its parent's sibling order are removed. A plain, non-
 * container record has no `recordIds` array to recurse into and behaves
 * exactly as before this feature.
 */
function deleteRecordAndChildren(doc: Y.Doc, id: string): void {
	const yrecord = recordsMap(doc).get(id);
	if (!yrecord) return;
	const childIds = yrecord.get('recordIds')?.toArray();
	if (childIds) {
		for (const childId of childIds) {
			// Only recurse into a child whose own `parentId` still
			// authoritatively agrees — a concurrent cross-container
			// moveRecordToParent can leave a stale array entry here for a
			// record that now legitimately lives under a *different* parent
			// (see listRecordsForParent's own doc comment on this same race).
			// Recursing into it unconditionally would delete a live record
			// out of its real, current parent as a side effect of deleting
			// this one — not just render a harmless duplicate. `id`'s own
			// `recordIds` array (including this stale entry) is discarded
			// wholesale below regardless, so skipping it here is enough;
			// nothing needs to be individually removed from it.
			if (isAuthoritativeChild(doc, id, childId)) deleteRecordAndChildren(doc, childId);
		}
	}
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
}

/**
 * Deletes a record (and, for a container block, all of its descendants) and
 * removes its id from its parent's sibling order. A direct delete of one
 * `column` is rejected once its `columns` block is already at
 * MIN_COLUMN_COUNT (issue #148) — deleting the whole `columns` block instead
 * is unaffected, since that recurses via deleteRecordAndChildren directly
 * rather than through this per-column guard.
 */
export function deleteRecord(doc: Y.Doc, id: string): void {
	doc.transact(() => {
		const yrecord = recordsMap(doc).get(id);
		if (yrecord?.get('blockType') === 'column') {
			const columnsId = yrecord.get('parentId')!;
			const siblingCount = recordsMap(doc).get(columnsId)?.get('recordIds')?.length ?? 0;
			if (siblingCount <= MIN_COLUMN_COUNT) {
				throw new ValidationError(
					`A columns block must keep at least ${MIN_COLUMN_COUNT} columns — delete the columns block itself instead.`
				);
			}
		}
		deleteRecordAndChildren(doc, id);
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
		// A record's own `parentId` field and its id's presence in a sibling
		// array are two independently-merged pieces of CRDT state (issue
		// #148's moveRecordToParent, unlike same-array reorderRecord, spans
		// two different Y.Arrays) — two replicas concurrently moving the same
		// record to two *different* destination containers can each insert it
		// into their own target array (no conflict between them, since
		// they're different arrays), while `parentId`'s own last-write-wins
		// resolution deterministically picks one winner. Filtering by
		// `record.parentId === parentId` here means every replica converges
		// on showing the record only in its one authoritative location — the
		// losing container's leftover array entry is skipped, not rendered as
		// a ghost duplicate — without needing to mutate anything during a
		// read. Same check as `isAuthoritativeChild` above, inlined here since
		// `record` is already fetched for the return value anyway.
		if (record?.parentId === parentId) records.push(record);
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
	if (kind !== 'document' && kind !== 'record') {
		throw new ValidationError(
			'reorderRecord only supports blocks within a Document or a container block'
		);
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

/**
 * Reparents a block from its current parent into `newParentId` — the
 * cross-container counterpart to reorderRecord's same-parent reposition
 * (issue #148's drag/keyboard-move-a-block-between-columns), built the same
 * way (delete from the old sibling array, insert into the new one, one
 * transaction) plus updating the record's own `parentId` field, which
 * reorderRecord never needs to touch since it never changes there. Like
 * reorderRecord, this only ever repositions structure — content, blockType,
 * and provenance on the moved record are untouched, and its own
 * lastEditedBy/At is deliberately left alone (moving a block is a placement
 * fact, not a content edit). `newParentId` must already resolve to a
 * Document or an existing container record (parentKindOf); moving a record
 * into itself or into one of its own descendants is rejected — that would
 * create a container that (transitively) contains itself, which
 * listRecordsForParent's recursion has no way to terminate on.
 */
export function moveRecordToParent(
	doc: Y.Doc,
	id: string,
	newParentId: string,
	afterRecordId?: string
): void {
	if (id === newParentId) {
		throw new ValidationError('Cannot move a record into itself');
	}
	const yrecord = recordsMap(doc).get(id);
	if (!yrecord) throw new NotFoundError(`Record ${id} not found`);
	const newKind = parentKindOf(doc, newParentId);
	if (!newKind) throw new NotFoundError(`Parent ${newParentId} not found`);

	let ancestor: string | undefined = newParentId;
	for (let guard = 0; ancestor !== undefined && guard < 50; guard++) {
		if (ancestor === id) {
			throw new ValidationError('Cannot move a record into its own descendant');
		}
		ancestor = recordsMap(doc).get(ancestor)?.get('parentId');
	}

	const oldParentId = yrecord.get('parentId')!;
	const oldKind = parentKindOf(doc, oldParentId);
	if (afterRecordId === id) {
		throw new ValidationError('Cannot move a block after itself');
	}

	doc.transact(() => {
		if (oldKind) {
			const oldSiblingIds = parentRecordIds(doc, oldParentId, oldKind);
			for (let i = oldSiblingIds.length - 1; i >= 0; i--) {
				if (oldSiblingIds.get(i) === id) oldSiblingIds.delete(i, 1);
			}
		}

		const newSiblingIds = parentRecordIds(doc, newParentId, newKind);
		const ids = newSiblingIds.toArray();
		const insertAt = afterRecordId ? ids.indexOf(afterRecordId) + 1 : 0;
		if (afterRecordId && insertAt === 0) {
			throw new NotFoundError(`Record ${afterRecordId} not found among siblings`);
		}
		newSiblingIds.insert(insertAt, [id]);
		yrecord.set('parentId', newParentId);
	});
}

/**
 * Creates a sibling copy of a record immediately after the original — fresh
 * ids throughout, its content and fields copied verbatim, and (for a
 * container block, i.e. `columns`/`column`, issue #148) every descendant
 * duplicated recursively along with it, since a container has no independent
 * meaning once its children are gone (mirrors deleteRecordAndChildren's own
 * recursion, run forward instead of as a teardown). Duplicating a `columns`
 * block therefore duplicates its `column` children and every block inside
 * them, all with new ids, in the same relative order.
 *
 * Provenance (createdBy/createdAt/lastEditedBy/lastEditedAt) is stamped
 * fresh under `actor` on every duplicated record, like any other newly
 * created one — a duplicate is new content, not a historical copy with
 * borrowed authorship.
 */
export function duplicateRecord(doc: Y.Doc, id: string, actor: ActorId): WorkspaceRecord {
	const source = getRecord(doc, id);
	if (!source) throw new NotFoundError(`Record ${id} not found`);
	return doc.transact(() => duplicateRecordInto(doc, id, source.parentId, id, actor));
}

// `afterRecordId` is the source's own id purely as a convenient "insert right
// after this sibling" marker at the top call — createRecord resolves it
// against `parentId`'s *actual* current siblings, and the real source block
// is always one of them at the top level (recursive calls instead pass the
// *previous copy's* id, so children land in the same relative order as the
// source's).
function duplicateRecordInto(
	doc: Y.Doc,
	sourceId: string,
	parentId: string,
	afterRecordId: string | undefined,
	actor: ActorId
): WorkspaceRecord {
	const source = getRecord(doc, sourceId)!;
	const copy = createRecord(
		doc,
		{
			parentId,
			afterRecordId,
			blockType: source.blockType,
			properties: source.properties,
			checked: source.checked,
			collapsed: source.collapsed,
			referencedRecordId: source.referencedRecordId,
			viewConfig: source.viewConfig,
			calloutStyle: source.calloutStyle,
			childPagesDepth: source.childPagesDepth,
			fullWidth: source.fullWidth
		},
		actor
	);

	const sourceText = getRecordYText(doc, sourceId);
	const copyText = getRecordYText(doc, copy.id);
	if (sourceText && copyText) {
		applyRichTextToYText(copyText, yTextToRichText(sourceText));
	}

	if (source.childRecordIds) {
		// createRecord auto-seeds a bare `column` with one empty paragraph (see
		// its own column-seeding step) — discard that placeholder before
		// copying the source's real children, so duplicating a column doesn't
		// leave a stray extra paragraph ahead of its copied content.
		if (copy.blockType === 'column') {
			for (const seeded of listRecordsForParent(doc, copy.id)) {
				deleteRecordAndChildren(doc, seeded.id);
			}
		}
		let previousCopyId: string | undefined;
		for (const childId of source.childRecordIds) {
			// Skip a stale child-array entry the same way deleteRecordAndChildren
			// does — a concurrent moveRecordToParent can leave one behind for a
			// record that has since (legitimately) moved to a different parent.
			if (!isAuthoritativeChild(doc, sourceId, childId)) continue;
			const childCopy = duplicateRecordInto(doc, childId, copy.id, previousCopyId, actor);
			previousCopyId = childCopy.id;
		}
	}

	return getRecord(doc, copy.id)!;
}

// `depth` counts container nesting only (0 at the Document's own top level, 1
// inside a column, and so on) — heading hierarchy is a presentational
// concern the caller derives separately from each block's own `blockType`,
// not something the walk below tracks itself.
export interface FlattenedBlock {
	record: WorkspaceRecord;
	depth: number;
}

/**
 * Every block belonging to a Document, in true document reading order —
 * including blocks nested inside a container's children (`columns`/`column`,
 * issue #148), unlike `listRecordsForParent`, which only returns one
 * parent's own direct children. Built for the List View / outline panel
 * (issue #152), which needs a flat, ordered walk of the whole block tree, not
 * just the Document's own top-level flow.
 */
export function flattenDocumentBlocks(doc: Y.Doc, documentId: string): FlattenedBlock[] {
	const result: FlattenedBlock[] = [];
	function walk(parentId: string, depth: number): void {
		for (const record of listRecordsForParent(doc, parentId)) {
			result.push({ record, depth });
			if (record.childRecordIds) walk(record.id, depth + 1);
		}
	}
	walk(documentId, 0);
	return result;
}
