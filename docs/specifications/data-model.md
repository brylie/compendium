# Data model

**Depends on:** [`agent-workspace-prd.md`](../agent-workspace-prd.md) (all decisions there are inherited, not re-litigated here)

---

## 1. Record/Document/Collection types

```typescript
type ActorId =
	| { kind: 'human'; userId: string }
	| { kind: 'agent'; agentId: string; name: string }
	| { kind: 'human-via-client'; userId: string; client: string }; // "Brylie · via Claude Desktop"

type PropertyValue =
	| { type: 'text'; value: string }
	| { type: 'number'; value: number }
	| { type: 'date'; value: string } // ISO 8601
	| { type: 'select'; value: string } // option id, defined in the Collection's schema
	| { type: 'checkbox'; value: boolean }
	| { type: 'relation'; value: string[] }; // record IDs

interface PropertyDefinition {
	key: string;
	label: string;
	type: PropertyValue['type'];
	options?: { id: string; label: string; color?: string }[]; // for 'select'
}

// A block IS a record — this isn't a separate type, just a record whose
// parent is a Document rather than a Collection. Kept as one shape so the
// MCP tool surface never needs to special-case "block vs. row."
interface Record {
	id: string; // stable, globally unique
	parentId: string; // Document ID or Collection ID
	order: string; // fractional index, orders records within parentId
	blockType?: string; // set when parent is a Document: 'paragraph' | 'heading' | 'list-item' | 'table' | 'code' | 'embed'
	content?: RichText; // set when parent is a Document — the block's text
	properties?: Record<string, PropertyValue>; // set when parent is a Collection
	createdBy: ActorId;
	createdAt: number;
	lastEditedBy: ActorId;
	lastEditedAt: number;
}

interface RichText {
	// Conceptually a run array (see PRD's Core Architectural Principle). Concretely,
	// realized as a Y.Text with formatting attributes — see §2. This TypeScript
	// shape is what the MCP boundary and the UI layer both see; the Y.Text
	// encoding is an internal storage detail behind it.
	runs: { text: string; marks: TextMarks }[];
}

interface TextMarks {
	bold?: boolean;
	italic?: boolean;
	strikethrough?: boolean;
	code?: boolean;
	link?: string;
	mention?: string; // ActorId's userId or agentId
}

interface Document {
	id: string;
	title: string;
	recordIds: string[]; // ordered — the Document's blocks, in order
}

interface Collection {
	id: string;
	title: string;
	schema: PropertyDefinition[];
	recordIds: string[]; // membership; row order within a view is a view concern, not stored here
}
```

## 2. Yjs mapping

One `Y.Doc` for the whole workspace (single-tenant, single workspace — no need for multiple docs yet).

| Concept           | Yjs type                        | Notes                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documents index   | `Y.Map<string, DocumentMeta>`   | keyed by Document ID; `DocumentMeta` is `{title, recordIds: Y.Array<string>}`                                                                                                                                                                                                                                                                                             |
| Collections index | `Y.Map<string, CollectionMeta>` | keyed by Collection ID; includes `schema` as a plain JSON value (schema edits are rare, don't need fine-grained CRDT merge)                                                                                                                                                                                                                                               |
| Records           | `Y.Map<string, Y.Map>`          | keyed by record ID; each record's own `Y.Map` holds `parentId`, `order`, `blockType`, `properties` (plain JSON), and — for block-records — `content`                                                                                                                                                                                                                      |
| Block rich text   | `Y.Text`                        | one per block-record, stored as the record's `content` field. **Not** a custom run array — Yjs's own `Y.Text.format()` already stores marks as attribute ranges over the text and merges concurrent overlapping formatting correctly (see PRD's rich-text acceptance criterion). The `RichText.runs` shape in §1 is derived from `Y.Text` on read, not stored separately. |

**Why not a `Y.Text` per Document instead of one per block:** merging at the whole-document level would make block-level hold/release (see [`collaboration.md`](./collaboration.md)) meaningless — the CRDT and the coordination layer need to operate at the same granularity. One `Y.Text` per block-record keeps them aligned.
