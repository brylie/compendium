import type * as Y from 'yjs';
import { BLOCK_CAPABILITIES } from '$lib/data/block-capabilities';
import {
	getRecord,
	listRecordsForParent,
	moveRecordToParent,
	reorderRecord
} from '$lib/data/record-ops';
import type { WorkspaceRecord } from '$lib/data/types';
import type { BlockSelectionController } from './block-selection.svelte';

export interface BlockDragOptions {
	getYdoc: () => Y.Doc | undefined;
	/** Fallback container for a pointer-drag started outside any resolvable container — always the Document's own top-level id. */
	getDefaultParentId: () => string;
	/** Reports a move outcome for the aria-live reorder announcement (shared with the multi-select group move). */
	announceMoved: (message: string) => void;
	/** Refocuses a block's own move handle after a keyboard-driven move. */
	focusDragHandle: (blockId: string) => Promise<void>;
	/** Shift/Ctrl/Cmd-clicking or Shift-Arrowing a move handle selects instead of dragging/reordering (issue #152) — see startBlockDrag/handleDragHandleKeydown below. */
	selection: BlockSelectionController;
}

/**
 * Owns the Document editor's block reordering (#40) — a visible move handle
 * in each block's gutter, draggable with the pointer or operable with the
 * keyboard once focused (extracted for #241). Both paths end up calling
 * reorderRecord (same container) or moveRecordToParent (a different
 * container — issue #148's move a block into/out of a column), which only
 * ever reposition/reparent a block — content, blockType, and provenance are
 * never touched by either.
 *
 * Every block list on the page (the Document's own top-level flow, and each
 * column inside a columns block) tags its rows with data-block-row +
 * data-block-parent, and its own wrapper with data-block-container, so the
 * pointer-drag geometry below can resolve a drop target across all of them
 * uniformly rather than assuming a single flat list.
 */
export function createBlockDrag(options: BlockDragOptions) {
	const { getYdoc, getDefaultParentId, announceMoved, focusDragHandle, selection } = options;

	let draggingBlockId: string | null = $state(null);
	let dropIndicatorIndex: number | null = $state(null);
	// Which container (the Document, or a column, issue #148) the drop
	// indicator above currently belongs to — a plain index alone is
	// ambiguous once more than one block list is on screen at once.
	let dropIndicatorParentId: string | null = $state(null);

	function announceBlockMoved(newIndex: number, parentId: string, location?: string): void {
		const ydoc = getYdoc();
		if (!ydoc) return;
		const total = listRecordsForParent(ydoc, parentId).length;
		const suffix = location ? ` in ${location}` : '';
		announceMoved(`Moved block to position ${newIndex + 1} of ${total}${suffix}.`);
	}

	// Resolves what "up"/"down"/"start"/"end" means in terms of
	// reorderRecord's own afterRecordId semantics — split out from moveBlock
	// below purely to keep each function's branching within the cognitive
	// complexity budget; sequential early-return `if`s (not else-if) here
	// avoid the nesting penalty an else-if chain would add.
	function computeMoveTarget(
		siblings: WorkspaceRecord[],
		target: 'up' | 'down' | 'start' | 'end',
		currentIndex: number,
		lastIndex: number
	): { afterRecordId: string | undefined; newIndex: number } | null {
		if (target === 'start') {
			if (currentIndex === 0) return null;
			return { afterRecordId: undefined, newIndex: 0 };
		}
		if (target === 'end') {
			if (currentIndex === lastIndex) return null;
			return { afterRecordId: siblings[lastIndex].id, newIndex: lastIndex };
		}
		if (target === 'up') {
			if (currentIndex === 0) return null;
			const afterRecordId = currentIndex >= 2 ? siblings[currentIndex - 2].id : undefined;
			return { afterRecordId, newIndex: currentIndex - 1 };
		}
		if (currentIndex === lastIndex) return null;
		return { afterRecordId: siblings[currentIndex + 1].id, newIndex: currentIndex + 1 };
	}

	// Keyboard equivalent of dragging: an adjacent swap with the previous/next
	// sibling within the block's own current container, or a direct move to
	// the very start/end of that same container — reusing reorderRecord's own
	// afterRecordId semantics rather than the pointer-drag path's
	// index-into-the-original-list math below, since "swap with my neighbor"
	// is simpler to express directly. Not container-crossing — see
	// moveBlockToAdjacentColumn for that (bound to ArrowLeft/ArrowRight).
	function moveBlock(blockId: string, target: 'up' | 'down' | 'start' | 'end'): void {
		const ydoc = getYdoc();
		if (!ydoc) return;
		const record = getRecord(ydoc, blockId);
		if (!record) return;
		const siblings = listRecordsForParent(ydoc, record.parentId);
		const currentIndex = siblings.findIndex((b) => b.id === blockId);
		if (currentIndex === -1) return;
		const move = computeMoveTarget(siblings, target, currentIndex, siblings.length - 1);
		if (!move) return;

		reorderRecord(ydoc, blockId, move.afterRecordId);
		announceBlockMoved(move.newIndex, record.parentId);
		void focusDragHandle(blockId);
	}

	// Moves a block sideways into the previous/next column of the same
	// columns block (issue #148) — the keyboard counterpart to dragging a
	// block across columns. A no-op when the block isn't currently inside a
	// column, or there's no column in that direction. Lands at the same index
	// (clamped) in the destination column, rather than always at its
	// start/end, so repeated presses read as "shift sideways," not "jump to
	// an end."
	function moveBlockToAdjacentColumn(blockId: string, direction: 'previous' | 'next'): void {
		const ydoc = getYdoc();
		if (!ydoc) return;
		const record = getRecord(ydoc, blockId);
		if (!record) return;
		const column = getRecord(ydoc, record.parentId);
		if (column?.blockType !== 'column') return;
		const columnsBlock = getRecord(ydoc, column.parentId);
		if (columnsBlock?.blockType !== 'columns') return;

		const siblingColumns = listRecordsForParent(ydoc, columnsBlock.id);
		const columnIndex = siblingColumns.findIndex((c) => c.id === column.id);
		const targetColumn =
			siblingColumns[direction === 'previous' ? columnIndex - 1 : columnIndex + 1];
		if (!targetColumn) return;

		const positionInColumn = listRecordsForParent(ydoc, column.id).findIndex(
			(b) => b.id === blockId
		);
		const targetSiblings = listRecordsForParent(ydoc, targetColumn.id);
		const insertIndex = Math.min(positionInColumn, targetSiblings.length);
		const afterRecordId = insertIndex > 0 ? targetSiblings[insertIndex - 1]?.id : undefined;

		moveRecordToParent(ydoc, blockId, targetColumn.id, afterRecordId);
		const targetColumnIndex = siblingColumns.findIndex((c) => c.id === targetColumn.id);
		announceBlockMoved(
			insertIndex,
			targetColumn.id,
			`column ${targetColumnIndex + 1} of ${siblingColumns.length}`
		);
		void focusDragHandle(blockId);
	}

	// The plain-move-key branch of handleDragHandleKeydown, split out purely to
	// keep that function's own cognitive complexity within budget — this
	// function assumes no modifier keys are held (its caller already checked).
	function handleDragHandleMoveKey(event: KeyboardEvent, blockId: string): void {
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			moveBlock(blockId, 'up');
		} else if (event.key === 'ArrowDown') {
			event.preventDefault();
			moveBlock(blockId, 'down');
		} else if (event.key === 'Home') {
			event.preventDefault();
			moveBlock(blockId, 'start');
		} else if (event.key === 'End') {
			event.preventDefault();
			moveBlock(blockId, 'end');
		} else if (event.key === 'ArrowLeft') {
			event.preventDefault();
			moveBlockToAdjacentColumn(blockId, 'previous');
		} else if (event.key === 'ArrowRight') {
			event.preventDefault();
			moveBlockToAdjacentColumn(blockId, 'next');
		} else if (event.key === 'Escape' && selection.ids.size > 0) {
			event.preventDefault();
			selection.clear();
		}
	}

	function handleDragHandleKeydown(event: KeyboardEvent, blockId: string): void {
		// Shift+ArrowUp/Down extends the multi-select range from the current
		// anchor (issue #152) — the keyboard equivalent of Shift-clicking the
		// handle, checked before the plain-move branch below so a held Shift
		// never also triggers a reorder.
		if (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) {
			if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
				event.preventDefault();
				selection.extendByKeyboard(blockId, event.key === 'ArrowUp' ? 'up' : 'down');
			}
			return;
		}
		if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
		handleDragHandleMoveKey(event, blockId);
	}

	// Every drop container currently on screen (the Document's own top-level
	// flow, plus one per column) and its bounding rect.
	function containerRectsOnScreen(): { parentId: string; rect: DOMRect }[] {
		return Array.from(document.querySelectorAll<HTMLElement>('[data-block-container]')).map(
			(el) => ({
				parentId: el.dataset.blockContainer!,
				rect: el.getBoundingClientRect()
			})
		);
	}

	// Resolves which container a drag point is currently over. A column's own
	// container rect is nested inside the Document's top-level one, so when a
	// point falls inside more than one, the smallest (most specific)
	// container wins — otherwise a drag over a column would always resolve
	// to the whole page instead.
	function resolveDropContainer(
		clientX: number,
		clientY: number,
		fallbackParentId: string
	): string {
		const hits = containerRectsOnScreen().filter(
			(c) =>
				clientX >= c.rect.left &&
				clientX <= c.rect.right &&
				clientY >= c.rect.top &&
				clientY <= c.rect.bottom
		);
		if (hits.length === 0) return fallbackParentId;
		hits.sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height);
		return hits[0].parentId;
	}

	// Finds the boundary between rendered block rows (within one container)
	// closest to clientY, as an index into that container's *current*
	// (pre-move) sibling array — 0..siblings.length, where siblings.length
	// means "after the last block."
	function dropIndexInContainer(parentId: string, clientY: number): number {
		const rows = Array.from(
			document.querySelectorAll<HTMLElement>(
				`[data-block-row][data-block-parent="${CSS.escape(parentId)}"]`
			)
		);
		for (let i = 0; i < rows.length; i++) {
			const rect = rows[i].getBoundingClientRect();
			if (clientY < rect.top + rect.height / 2) return i;
		}
		return rows.length;
	}

	// targetIndex is a drop-indicator position computed against
	// targetParentId's *current* siblings (still including blockId at its old
	// slot, if it was already there) — translated here into
	// reorderRecord/moveRecordToParent's afterRecordId (resolved among
	// blockId's prospective siblings, i.e. that same array *without*
	// blockId).
	function moveBlockToContainerIndex(
		blockId: string,
		targetParentId: string,
		targetIndex: number
	): void {
		const ydoc = getYdoc();
		if (!ydoc) return;
		const record = getRecord(ydoc, blockId);
		if (!record) return;

		if (record.parentId === targetParentId) {
			const siblings = listRecordsForParent(ydoc, targetParentId);
			const currentIndex = siblings.findIndex((b) => b.id === blockId);
			if (currentIndex === -1) return;
			const adjusted = targetIndex > currentIndex ? targetIndex - 1 : targetIndex;
			if (adjusted === currentIndex) return; // dropped back at its own position
			const withoutSelf = siblings.filter((b) => b.id !== blockId);
			const afterRecordId = adjusted > 0 ? withoutSelf[adjusted - 1]?.id : undefined;
			reorderRecord(ydoc, blockId, afterRecordId);
			announceBlockMoved(adjusted, targetParentId);
			return;
		}

		// Cross-container move (issue #148) — into/out of a column. Dropping
		// into a column is restricted to the same curated
		// BLOCK_CAPABILITIES.column.childBlockTypes set create_record enforces
		// at creation time (services/records.ts) — the drag path bypasses that
		// service-layer check entirely (a direct data-layer call, like every
		// other UI mutation), so it needs its own guard here or an unsupported
		// type (e.g. a table or another columns block) could be dropped into a
		// column with nothing to render it.
		const targetContainer = getRecord(ydoc, targetParentId);
		if (targetContainer?.blockType === 'column') {
			const allowed = BLOCK_CAPABILITIES.column.childBlockTypes;
			if (!allowed?.includes(record.blockType ?? 'paragraph')) return;
		}
		const destSiblings = listRecordsForParent(ydoc, targetParentId);
		const afterRecordId = targetIndex > 0 ? destSiblings[targetIndex - 1]?.id : undefined;
		moveRecordToParent(ydoc, blockId, targetParentId, afterRecordId);
		announceBlockMoved(targetIndex, targetParentId);
	}

	function cleanupDragListeners(): void {
		window.removeEventListener('pointermove', handleDragPointerMove);
		window.removeEventListener('pointerup', handleDragPointerUp);
		window.removeEventListener('pointercancel', cancelDrag);
		window.removeEventListener('keydown', handleDragEscapeKeydown);
	}

	function cancelDrag(): void {
		cleanupDragListeners();
		draggingBlockId = null;
		dropIndicatorIndex = null;
		dropIndicatorParentId = null;
	}

	function handleDragPointerMove(event: PointerEvent): void {
		const ydoc = getYdoc();
		if (!draggingBlockId || !ydoc) return;
		const sourceParentId = getRecord(ydoc, draggingBlockId)?.parentId ?? getDefaultParentId();
		const containerId = resolveDropContainer(event.clientX, event.clientY, sourceParentId);
		dropIndicatorParentId = containerId;
		dropIndicatorIndex = dropIndexInContainer(containerId, event.clientY);
	}

	function handleDragPointerUp(): void {
		const blockId = draggingBlockId;
		const targetParentId = dropIndicatorParentId;
		const targetIndex = dropIndicatorIndex;
		cleanupDragListeners();
		draggingBlockId = null;
		dropIndicatorIndex = null;
		dropIndicatorParentId = null;
		if (blockId !== null && targetParentId !== null && targetIndex !== null) {
			moveBlockToContainerIndex(blockId, targetParentId, targetIndex);
		}
	}

	function handleDragEscapeKeydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') cancelDrag();
	}

	function startBlockDrag(
		event: PointerEvent,
		blockId: string,
		parentId: string,
		index: number
	): void {
		// Only the primary button/touch starts a drag — a right-click or an
		// auxiliary button on the handle shouldn't hijack a context menu.
		if (event.button !== 0) return;
		// Shift/Ctrl/Cmd-clicking the move handle selects a range/toggles a
		// block instead of dragging it (issue #152 multi-select) — the same
		// modifier-click convention a file manager or spreadsheet uses, chosen
		// specifically so it can't collide with a plain drag-to-reorder click.
		if (event.shiftKey || event.ctrlKey || event.metaKey) {
			event.preventDefault();
			if (event.shiftKey) {
				selection.extendRange(blockId, parentId, index);
			} else {
				selection.toggle(blockId, parentId);
			}
			return;
		}
		event.preventDefault();
		draggingBlockId = blockId;
		dropIndicatorParentId = parentId;
		dropIndicatorIndex = index;
		window.addEventListener('pointermove', handleDragPointerMove);
		window.addEventListener('pointerup', handleDragPointerUp);
		// The browser can cancel the pointer stream without ever firing
		// pointerup — e.g. a touch drag that turns into a page scroll — which
		// would otherwise leave the drag state (and these listeners) stuck
		// active until an unrelated future pointerup silently commits a
		// reorder the user never asked for.
		window.addEventListener('pointercancel', cancelDrag);
		window.addEventListener('keydown', handleDragEscapeKeydown);
	}

	return {
		get draggingBlockId() {
			return draggingBlockId;
		},
		get dropIndicatorIndex() {
			return dropIndicatorIndex;
		},
		get dropIndicatorParentId() {
			return dropIndicatorParentId;
		},
		moveBlock,
		moveBlockToAdjacentColumn,
		handleDragHandleKeydown,
		startBlockDrag,
		/** Guards against a leaked window listener if the page unmounts mid-drag — call from a teardown effect. */
		dispose: cleanupDragListeners
	};
}

export type BlockDragController = ReturnType<typeof createBlockDrag>;
