import type * as Y from 'yjs';
import type {
	ActorId,
	BlockType,
	CalloutStyle,
	ChildPagesDepth,
	PropertyDefinition,
	PropertyValue
} from './types';
import { type TypedYMap, typedYMapRegistry } from './yjs-typed';

export const DOCUMENTS = 'documents';
export const COLLECTIONS = 'collections';
export const RECORDS = 'records';

// Properties are stored as individual `prop:<key>` entries on the record's
// Y.Map, rather than one JSON blob under a single key, so two humans editing
// different properties of the same row concurrently each merge (Y.Map's
// per-key LWW) instead of one clobbering the other's unrelated edit.
export const PROP_PREFIX = 'prop:';

// The known field shape of each top-level Y.Map's entries — the single
// source of truth TypedYMap uses to give every get/set on these maps a real
// type instead of `unknown` (issue #174). `recordIds` on Document/Collection
// carries the Y.Array itself (not its snapshot), same as the raw Yjs shape
// always has.
export interface DocumentYShape {
	id: string;
	title: string;
	parentDocumentId?: string;
	order: string;
	recordIds: Y.Array<string>;
}

export interface CollectionYShape {
	title: string;
	schema: PropertyDefinition[];
	recordIds: Y.Array<string>;
	primaryFieldKey?: string;
}

// Collection-row properties aren't part of this shape: they live under
// dynamic `prop:<key>` entries (see PROP_PREFIX above), read/written via
// getPropertyValue/setPropertyValue/deletePropertyValue below rather than
// TypedYMap's fixed-key get/set. A collection_view block's viewConfig is the
// same story: dynamic `viewConfig:<field>` entries (see view-config.ts),
// read/written via readViewConfig/writeViewConfigField there.
export interface RecordYShape {
	id: string;
	parentId: string;
	order: string;
	blockType?: BlockType;
	content?: Y.Text;
	isCollectionRow?: boolean;
	checked?: boolean;
	collapsed?: boolean;
	referencedRecordId?: string;
	calloutStyle?: CalloutStyle;
	childPagesDepth?: ChildPagesDepth;
	createdBy: ActorId;
	createdAt: number;
	lastEditedBy: ActorId;
	lastEditedAt: number;
}

/** The workspace's top-level Documents `Y.Map`, typed via TypedYMap. */
export function documentsMap(doc: Y.Doc) {
	return typedYMapRegistry<DocumentYShape>(doc.getMap(DOCUMENTS));
}
/** The workspace's top-level Collections `Y.Map`, typed via TypedYMap. */
export function collectionsMap(doc: Y.Doc) {
	return typedYMapRegistry<CollectionYShape>(doc.getMap(COLLECTIONS));
}
/** The workspace's top-level records (blocks and rows) `Y.Map`, typed via TypedYMap. */
export function recordsMap(doc: Y.Doc) {
	return typedYMapRegistry<RecordYShape>(doc.getMap(RECORDS));
}

/** Writes one Collection-row property value under its `prop:<key>` entry. */
export function setPropertyValue(
	yrecord: TypedYMap<RecordYShape>,
	key: string,
	value: PropertyValue
): void {
	yrecord.raw.set(PROP_PREFIX + key, value);
}
/** Clears one Collection-row property value's `prop:<key>` entry. */
export function deletePropertyValue(yrecord: TypedYMap<RecordYShape>, key: string): void {
	yrecord.raw.delete(PROP_PREFIX + key);
}
