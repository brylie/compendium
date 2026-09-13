import { columnChildBlockTypes, type BlockType } from './types';

export interface BlockFieldContract {
	/**
	 * MCP argument names (`create_record`'s own zod schema, `mcp/server.ts`) —
	 * not necessarily the underlying `WorkspaceRecord` field name — this type
	 * accepts via `create_record`, beyond `parentId`/`afterRecordId`/`blockType`.
	 * Free-form text is `markdown` here (the actual argument name), not
	 * `content` (the internal `WorkspaceRecord`/Y.Text field it lands in).
	 */
	creatable: readonly string[];
	/**
	 * MCP argument names `write_record` accepts for this type after creation.
	 * Overlaps `creatable` for an argument settable both at creation and later
	 * (e.g. page_link's `referencedRecordId`); an argument in `creatable` but
	 * not here is set-once-at-creation only (e.g. child_pages' `childPagesDepth`).
	 */
	writable: readonly string[];
	/**
	 * `WorkspaceRecord` field names `get_document` exposes for this type with
	 * no MCP write path at all — neither `create_record` nor `write_record`
	 * accepts an argument for them; UI-only (e.g. `to_do`'s `checked`). Named
	 * as record fields, not MCP arguments, since no MCP argument exists.
	 */
	readOnly: readonly string[];
}

export interface BlockCapabilities {
	/** True for a block whose children are other WorkspaceRecords (`columns`/`column`, issue #148) rather than an ordinary Document-kind record's own `content` Y.Text. */
	isContainer: boolean;
	/** Only set for a container type — the BlockTypes it may directly hold (enforced at creation by `services/records.ts`'s `validateBlockTypeForParent`). */
	childBlockTypes?: readonly BlockType[];
	/** True when the block holds free-form inline text that Enter/Backspace-join and in-place conversion can act on (`rich-text-toolbar.md` §5) — false for structural/reference/container/computed types. */
	holdsFreeformText: boolean;
	/**
	 * Human label and one-line description — the single source of truth for both
	 * the UI slash menu (`SlashMenu.svelte`) and the MCP `list_block_types`
	 * discovery tool (issue #29), so the two surfaces can't drift the text the
	 * way they could before this table covered anything beyond capability flags.
	 */
	label: string;
	description: string;
	/** The `create_record`/`write_record` argument contract for this type — see `mcp-tools.md`. */
	fields: BlockFieldContract;
	/**
	 * Present only for a type where `referencedRecordId` applies — what the id
	 * resolves to, and what an absent value means (this varies per type:
	 * "unconfigured" for page_link/collection_view, "defaults to the current
	 * Document" for child_pages, "no MCP write path" for synced_block).
	 */
	referencedRecordSemantics?: string;
	markdown: {
		/**
		 * Whether `write_record`'s `markdown` argument can ever change what
		 * `get_document` renders for this type. False only when a write is
		 * rejected outright (`isContainer` — `columns`/`column`) or silently
		 * has zero rendering effect in every state (`collection_view`,
		 * `child_pages`, whose markdown is always computed from other fields
		 * instead) — every other type's own `Y.Text` is created at `create_record`
		 * time (`record-ops.ts`) and rendered verbatim by `get_document`'s
		 * generic branch (`document-projection.ts`) regardless of
		 * `holdsFreeformText`, which governs UI Enter/Backspace/conversion
		 * behavior only, not the MCP write/render path. `page_link` is `true`
		 * but conditional — see its own `representation`.
		 */
		writable: boolean;
		/**
		 * One-line description of this type's Markdown read-direction
		 * representation at the `get_document`/`list_block_types` boundary —
		 * see `markdown-transcoding.md`. `richTextToMarkdown`
		 * (`data/markdown-transcode.ts`) only ever emits *inline* marks
		 * (bold/italic/strikethrough/code/links/\@mention/[[wiki-links]]); no
		 * block type gets a block-level Markdown prefix (heading `#`, bullet
		 * `-`, task `- [ ]`, blockquote `>`) except a preset-styled `callout`'s
		 * GitHub-alert marker — a heading's/list item's/quote's structural
		 * identity is conveyed only by the separate `blockType` field.
		 */
		representation: string;
	};
}

/**
 * Single source of truth for the block-type capability generalizations
 * introduced by #148's columns/column containment (`isContainer`,
 * `childBlockTypes`) and relied on by #152's action-menu conversion
 * (`holdsFreeformText`) — see `docs/specifications/block-capability-contract.md`.
 * `record-ops.ts`, `services/records.ts`'s `validateBlockTypeForParent`, and
 * the Document route's `blockHoldsFreeformText`/convert-menu logic all read
 * from this table instead of maintaining their own lists; `#229` closed the
 * gap left after #190 did the same for service-surface parity
 * (`serviceSurfaces` in `services/manifest.ts`).
 *
 * `label`/`description`/`fields`/`referencedRecordSemantics`/`markdown`
 * (issue #29) extend this same table so `SlashMenu.svelte`'s COMMAND
 * definitions and the MCP `list_block_types` tool (`services/blockTypes.ts`)
 * both read the same per-type contract instead of each maintaining their own
 * copy — the two surfaces this issue's own text calls out as unable to
 * afford drifting.
 */
export const BLOCK_CAPABILITIES: Record<BlockType, BlockCapabilities> = {
	paragraph: {
		isContainer: false,
		holdsFreeformText: true,
		label: 'Text',
		description: 'Just start writing with plain text.',
		fields: { creatable: [], writable: ['markdown'], readOnly: [] },
		markdown: {
			writable: true,
			representation:
				'Its inline-formatted text (bold/italic/strikethrough/code/links, plus @mention and [[Record Title]] wiki-links) — get_document adds no block-level Markdown syntax of its own.'
		}
	},
	heading_1: {
		isContainer: false,
		holdsFreeformText: true,
		label: 'Heading 1',
		description: 'Large section heading.',
		fields: { creatable: [], writable: ['markdown'], readOnly: [] },
		markdown: {
			writable: true,
			representation:
				'Its inline-formatted text only, same as paragraph — get_document does not prefix it with a Markdown heading marker (`#`); the heading level is conveyed by the separate blockType field, not markdown syntax.'
		}
	},
	heading_2: {
		isContainer: false,
		holdsFreeformText: true,
		label: 'Heading 2',
		description: 'Medium section heading.',
		fields: { creatable: [], writable: ['markdown'], readOnly: [] },
		markdown: {
			writable: true,
			representation:
				'Its inline-formatted text only, same as paragraph — get_document does not prefix it with a Markdown heading marker (`##`); the heading level is conveyed by the separate blockType field, not markdown syntax.'
		}
	},
	heading_3: {
		isContainer: false,
		holdsFreeformText: true,
		label: 'Heading 3',
		description: 'Small section heading.',
		fields: { creatable: [], writable: ['markdown'], readOnly: [] },
		markdown: {
			writable: true,
			representation:
				'Its inline-formatted text only, same as paragraph — get_document does not prefix it with a Markdown heading marker (`###`); the heading level is conveyed by the separate blockType field, not markdown syntax.'
		}
	},
	heading_4: {
		isContainer: false,
		holdsFreeformText: true,
		label: 'Heading 4',
		description: 'Sub-heading.',
		fields: { creatable: [], writable: ['markdown'], readOnly: [] },
		markdown: {
			writable: true,
			representation:
				'Its inline-formatted text only, same as paragraph — get_document does not prefix it with a Markdown heading marker (`####`); the heading level is conveyed by the separate blockType field, not markdown syntax.'
		}
	},
	bulleted_list_item: {
		isContainer: false,
		holdsFreeformText: true,
		label: 'Bulleted list',
		description: 'Create a simple bulleted list.',
		fields: { creatable: [], writable: ['markdown'], readOnly: [] },
		markdown: {
			writable: true,
			representation:
				'Its inline-formatted text only — get_document does not prefix it with a Markdown bullet marker (`-`); list membership is conveyed by the separate blockType field, not markdown syntax.'
		}
	},
	numbered_list_item: {
		isContainer: false,
		holdsFreeformText: true,
		label: 'Numbered list',
		description: 'Create an ordered numbered list.',
		fields: { creatable: [], writable: ['markdown'], readOnly: [] },
		markdown: {
			writable: true,
			representation:
				'Its inline-formatted text only — get_document does not render a Markdown ordered-list marker; its position among sibling numbered_list_items (not a stored value) is what determines its displayed number in the UI.'
		}
	},
	to_do: {
		isContainer: false,
		holdsFreeformText: true,
		label: 'To-do list',
		description: 'Track tasks with a to-do checkbox.',
		fields: { creatable: [], writable: ['markdown'], readOnly: ['checked'] },
		markdown: {
			writable: true,
			representation:
				'Its inline-formatted text only — get_document does not render a GFM task-list checkbox (`- [ ]`/`- [x]`); checked state is exposed separately via the read-only `checked` field, not markdown syntax.'
		}
	},
	quote: {
		isContainer: false,
		holdsFreeformText: true,
		label: 'Quote',
		description: 'Capture a quotation.',
		fields: { creatable: [], writable: ['markdown'], readOnly: [] },
		markdown: {
			writable: true,
			representation:
				'Its inline-formatted text only — get_document does not prefix it with a Markdown blockquote marker (`>`); this differs from a preset-styled callout, which does get a comparable prefix (see callout below).'
		}
	},
	divider: {
		isContainer: false,
		holdsFreeformText: false,
		label: 'Divider',
		description: 'Visually divide sections with a line.',
		fields: { creatable: [], writable: ['markdown'], readOnly: [] },
		markdown: {
			writable: true,
			representation:
				"No meaningful text by design — the block starts empty and the UI always draws a plain horizontal rule regardless of content — but write_record's markdown is technically accepted and rendered verbatim by get_document if ever called against one, the same as a paragraph."
		}
	},
	callout: {
		isContainer: false,
		holdsFreeformText: true,
		label: 'Callout',
		description: 'Highlight key notes and warnings.',
		fields: { creatable: [], writable: ['markdown'], readOnly: ['calloutStyle'] },
		markdown: {
			writable: true,
			representation:
				'Its inline text; a preset-styled callout additionally prefixes a GitHub-alert marker line (`> [!NOTE]`/`> [!TIP]`/`> [!CAUTION]`/`> [!DANGER]`) derived read-only from `calloutStyle` — a custom-styled callout renders as plain inline content with no alert marker.'
		}
	},
	toggle: {
		isContainer: false,
		holdsFreeformText: true,
		label: 'Toggle list',
		description: 'Hide or show content inside.',
		fields: { creatable: [], writable: ['markdown'], readOnly: ['collapsed'] },
		markdown: {
			writable: true,
			representation:
				'Its summary text only — toggle does not yet nest/hide real child blocks (issue #227) despite the container-with-children design it is ultimately intended to have (`block-capability-contract.md` §3).'
		}
	},
	table: {
		isContainer: false,
		holdsFreeformText: false,
		label: 'Table',
		description: 'Add a table for structured information.',
		fields: { creatable: [], writable: ['markdown'], readOnly: [] },
		markdown: {
			writable: true,
			representation:
				"Not yet backed by a structured row/cell field on WorkspaceRecord — write_record's markdown is technically accepted and rendered as plain inline text, identical to a paragraph, since no dedicated tabular data model or rendering exists yet."
		}
	},
	code: {
		isContainer: false,
		holdsFreeformText: true,
		label: 'Code',
		description: 'Capture a code snippet with monospace font.',
		fields: { creatable: [], writable: ['markdown'], readOnly: [] },
		markdown: {
			writable: true,
			representation: 'Its inline text — no fenced code-block wrapper is applied at this boundary.'
		}
	},
	table_of_contents: {
		isContainer: false,
		holdsFreeformText: false,
		label: 'Table of contents',
		description: 'Live outline of headings in this document.',
		fields: { creatable: [], writable: ['markdown'], readOnly: [] },
		markdown: {
			writable: true,
			representation:
				"Computed live from the containing Document's headings in the browser UI, not stored (`data-model.md` §3) — but get_document performs no such computation: write_record's markdown is accepted and rendered verbatim like any other block, with no relationship to the document's actual headings."
		}
	},
	synced_block: {
		isContainer: false,
		holdsFreeformText: false,
		label: 'Synced block',
		description: 'Reference content from another block.',
		fields: { creatable: [], writable: ['markdown'], readOnly: ['referencedRecordId'] },
		referencedRecordSemantics:
			"Identifies the source record this block mirrors in the browser UI. Settable only via the UI's own duplicate-as-synced-block action — create_record/write_record don't accept it for this type.",
		markdown: {
			writable: true,
			representation:
				"get_document renders this block's own stored text — write_record's markdown is accepted and persisted to it — but the live browser UI ignores this field entirely and resolves the block's displayed content through referencedRecordId's source record instead (`data-model.md` §3); the two can diverge."
		}
	},
	page_link: {
		isContainer: false,
		holdsFreeformText: false,
		label: 'Page link',
		description: 'Link to another document.',
		fields: {
			creatable: ['referencedRecordId'],
			writable: ['referencedRecordId', 'markdown'],
			readOnly: []
		},
		referencedRecordSemantics:
			"Identifies the target Document this link navigates to. Absent means an unconfigured link, rendering the block's own content instead. Settable at creation and retargetable later via write_record.",
		markdown: {
			writable: true,
			representation:
				"Renders as `[[Target Title]]` once configured, or `[[Deleted page]]` with `linkBroken: true` once the target is deleted; while unconfigured (no referencedRecordId), get_document instead renders write_record's written markdown as the block's own inline text. write_record's markdown argument is always accepted, but only visible in get_document's output during that unconfigured state — once referencedRecordId is set, any stored text is never rendered."
		}
	},
	embed: {
		isContainer: false,
		holdsFreeformText: false,
		label: 'Embed',
		description: 'Embed content from another source.',
		fields: { creatable: [], writable: ['markdown'], readOnly: [] },
		markdown: {
			writable: true,
			representation:
				"The generic external-content mechanism (`data-model.md` §3), with no dedicated field yet — write_record's markdown is accepted and rendered as plain inline content, identical to a paragraph."
		}
	},
	collection_view: {
		isContainer: false,
		holdsFreeformText: false,
		label: 'Collection view',
		description: 'Embed a Table, Board, or Calendar view of a collection.',
		fields: {
			creatable: ['referencedRecordId', 'viewConfig'],
			writable: ['referencedRecordId', 'viewConfig', 'viewConfigPatch'],
			readOnly: []
		},
		referencedRecordSemantics:
			'Identifies the target Collection this view embeds. Absent means an unconfigured embed. Settable at creation and retargetable later via write_record.',
		markdown: {
			writable: false,
			representation:
				"Renders as `[collection view: Target Title]`, `[collection view: Deleted collection]` with `linkBroken: true`, or `[collection view: unconfigured]` — never its own content, in every state; write_record's markdown argument is technically accepted (no error) but has no rendering effect here. `viewConfig` (its Table/Board/Calendar configuration) is exposed as a separate structured field, not folded into the markdown string."
		}
	},
	child_pages: {
		isContainer: false,
		holdsFreeformText: false,
		label: 'Child pages',
		description: "Live list of this page's sub-pages.",
		fields: {
			creatable: ['referencedRecordId', 'childPagesDepth'],
			writable: [],
			readOnly: []
		},
		referencedRecordSemantics:
			'Identifies the target Document whose sub-pages are listed. Absent defaults to the block\'s own containing Document — unlike page_link/collection_view, absent here does not mean "unconfigured". Settable only at creation; write_record has no path to change it afterward.',
		markdown: {
			writable: false,
			representation:
				"Nested `- [[Title]]` Markdown bullets, one per resolved child, indented per nesting level up to `childPagesDepth`; `_No sub-pages yet._` when empty; `[child pages: unavailable]` when an explicit target does not resolve — never its own content, in every state; write_record's markdown argument is technically accepted (no error) but has no rendering effect here."
		}
	},
	columns: {
		isContainer: true,
		childBlockTypes: ['column'],
		holdsFreeformText: false,
		label: 'Columns',
		description: 'Lay out content side by side.',
		fields: { creatable: ['columnCount'], writable: [], readOnly: [] },
		markdown: {
			writable: false,
			representation:
				"A Pandoc-style fenced div: `::: columns` wrapping one `::: column ... :::` block per column, each column's body the blank-line-joined markdown of its own children. write_record's markdown argument is rejected outright for this type (`services/records.ts`) — content must be written to one of its nested blocks instead."
		}
	},
	column: {
		isContainer: true,
		childBlockTypes: columnChildBlockTypes,
		holdsFreeformText: false,
		label: 'Column',
		description:
			'One column inside a Columns block — not directly insertable; created automatically when a Columns block is added, or by create_record against an existing Columns block.',
		fields: { creatable: [], writable: [], readOnly: [] },
		markdown: {
			writable: false,
			representation:
				"Its own children's markdown, blank-line joined and wrapped in a `::: column ... :::` fence by its parent columns block's projection — a column has no markdown representation of its own outside that context. write_record's markdown argument is rejected outright for this type (`services/records.ts`), same as columns."
		}
	}
};

// The safest possible defaults for a `blockType` this table doesn't
// recognize — leaf, no free-form text — matching what every per-site
// `===`/`.includes()` check this table replaced already did for an
// unrecognized value (never throw, never treat it as a container).
const UNKNOWN_BLOCK_CAPABILITIES: BlockCapabilities = {
	isContainer: false,
	holdsFreeformText: false,
	label: 'Unknown block',
	description: 'A block type this client does not recognize yet.',
	fields: { creatable: [], writable: [], readOnly: [] },
	markdown: {
		writable: false,
		representation: 'Unrecognized block type — no known representation.'
	}
};

/**
 * Looks up `blockType`'s capabilities, falling back to
 * `UNKNOWN_BLOCK_CAPABILITIES` instead of throwing. `BlockType` is a closed
 * TypeScript union, but a value read off a live Yjs record (`TypedYMap.get`
 * only casts, it never validates) can still carry a `blockType` this
 * client's own code doesn't recognize yet — e.g. a newer block type another,
 * differently-versioned client already wrote during a rolling deploy. Direct
 * `BLOCK_CAPABILITIES[blockType]` indexing would throw on that value; every
 * call site reading a `blockType` off existing record data should go through
 * this instead of indexing the table directly.
 */
export function blockCapabilitiesFor(blockType: BlockType): BlockCapabilities {
	return BLOCK_CAPABILITIES[blockType] ?? UNKNOWN_BLOCK_CAPABILITIES;
}
