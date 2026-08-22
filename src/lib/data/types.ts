// Data model per docs/technical-design.md §2.
// Note: the spec calls the record primitive "Record" — renamed to
// WorkspaceRecord here to avoid shadowing TypeScript's built-in Record<K, V>.

export type ActorId =
	| { kind: 'human'; userId: string }
	| { kind: 'agent'; agentId: string; name: string }
	| { kind: 'human-via-client'; userId: string; client: string }; // "Brylie · via Claude Desktop"

export type PropertyType = 'text' | 'number' | 'date' | 'select' | 'checkbox' | 'relation';

export type PropertyValue =
	| { type: 'text'; value: string }
	| { type: 'number'; value: number }
	| { type: 'date'; value: string } // ISO 8601
	| { type: 'select'; value: string } // option id, defined in the Collection's schema
	| { type: 'checkbox'; value: boolean }
	| { type: 'relation'; value: string[] }; // record IDs

export interface PropertyDefinition {
	key: string;
	label: string;
	type: PropertyType;
	options?: { id: string; label: string; color?: string }[]; // for 'select'
}

export type BlockType = 'paragraph' | 'heading' | 'list-item' | 'table' | 'code' | 'embed';

export interface TextMarks {
	bold?: boolean;
	italic?: boolean;
	strikethrough?: boolean;
	code?: boolean;
	link?: string;
	mention?: string; // ActorId's userId or agentId
}

export interface RichText {
	runs: { text: string; marks: TextMarks }[];
}

// A block IS a record — this isn't a separate type, just a record whose
// parent is a Document rather than a Collection. Kept as one shape so the
// MCP tool surface never needs to special-case "block vs. row."
export interface WorkspaceRecord {
	id: string; // stable, globally unique
	parentId: string; // Document ID or Collection ID
	order: string; // fractional index, orders records within parentId
	blockType?: BlockType; // set when parent is a Document
	content?: RichText; // set when parent is a Document — the block's text
	properties?: Record<string, PropertyValue>; // set when parent is a Collection
	createdBy: ActorId;
	createdAt: number;
	lastEditedBy: ActorId;
	lastEditedAt: number;
}

export interface DocumentMeta {
	id: string;
	title: string;
	recordIds: string[]; // ordered — the Document's blocks, in order
}

export interface CollectionMeta {
	id: string;
	title: string;
	schema: PropertyDefinition[];
	recordIds: string[]; // membership; row order within a view is a view concern
}

export type ParentKind = 'document' | 'collection';
