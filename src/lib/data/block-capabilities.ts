import { columnChildBlockTypes, type BlockType } from './types';

export interface BlockCapabilities {
	/** True for a block whose children are other WorkspaceRecords (`columns`/`column`, issue #148) rather than an ordinary Document-kind record's own `content` Y.Text. */
	isContainer: boolean;
	/** Only set for a container type — the BlockTypes it may directly hold (enforced at creation by `services/records.ts`'s `validateBlockTypeForParent`). */
	childBlockTypes?: readonly BlockType[];
	/** True when the block holds free-form inline text that Enter/Backspace-join and in-place conversion can act on (`rich-text-toolbar.md` §5) — false for structural/reference/container/computed types. */
	holdsFreeformText: boolean;
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
 */
export const BLOCK_CAPABILITIES: Record<BlockType, BlockCapabilities> = {
	paragraph: { isContainer: false, holdsFreeformText: true },
	heading_1: { isContainer: false, holdsFreeformText: true },
	heading_2: { isContainer: false, holdsFreeformText: true },
	heading_3: { isContainer: false, holdsFreeformText: true },
	heading_4: { isContainer: false, holdsFreeformText: true },
	bulleted_list_item: { isContainer: false, holdsFreeformText: true },
	numbered_list_item: { isContainer: false, holdsFreeformText: true },
	to_do: { isContainer: false, holdsFreeformText: true },
	quote: { isContainer: false, holdsFreeformText: true },
	divider: { isContainer: false, holdsFreeformText: false },
	callout: { isContainer: false, holdsFreeformText: true },
	toggle: { isContainer: false, holdsFreeformText: true },
	table: { isContainer: false, holdsFreeformText: false },
	code: { isContainer: false, holdsFreeformText: true },
	table_of_contents: { isContainer: false, holdsFreeformText: false },
	synced_block: { isContainer: false, holdsFreeformText: false },
	page_link: { isContainer: false, holdsFreeformText: false },
	embed: { isContainer: false, holdsFreeformText: false },
	collection_view: { isContainer: false, holdsFreeformText: false },
	child_pages: { isContainer: false, holdsFreeformText: false },
	columns: { isContainer: true, childBlockTypes: ['column'], holdsFreeformText: false },
	column: { isContainer: true, childBlockTypes: columnChildBlockTypes, holdsFreeformText: false }
};
