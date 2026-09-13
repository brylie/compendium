import { SvelteSet } from 'svelte/reactivity';
import type * as Y from 'yjs';
import {
	deleteRecord,
	duplicateRecord,
	getRecord,
	listRecordsForParent,
	reorderRecord
} from '$lib/data/record-ops';
import type { WorkspaceRecord } from '$lib/data/types';
import { LOCAL_UI_ORIGIN, transactWithOrigin } from '$lib/mutation-origin';
import { CURRENT_USER } from './actor';

export interface BlockSelectionOptions {
	getYdoc: () => Y.Doc | undefined;
	/** Reports a group-move outcome for the aria-live reorder announcement (shared with drag-and-drop moves). */
	announceMoved: (message: string) => void;
	/** Refocuses a block's move handle after a keyboard-driven selection change — same handle drag-and-drop's own keyboard moves refocus. */
	focusDragHandle: (blockId: string) => Promise<void>;
}

interface SelectionGroupBounds {
	siblings: WorkspaceRecord[];
	groupStart: number;
	groupEnd: number;
}

/**
 * Owns the Document editor's multi-select state (issue #152, extracted for
 * #241) — a set of block ids, always siblings of one another within the same
 * parent container (the Document's own top level, or one column).
 * `anchorId` is the fixed end of a Shift-click/Shift-Arrow range; the other
 * end is whatever block was just interacted with. Selecting in a different
 * container replaces the set outright rather than mixing containers — group
 * move/delete below assume a single shared parent.
 */
export function createBlockSelection(options: BlockSelectionOptions) {
	const { getYdoc, announceMoved, focusDragHandle } = options;
	const ids = new SvelteSet<string>();
	let anchorId: string | null = $state(null);

	function clear(): void {
		ids.clear();
		anchorId = null;
	}

	// True when the current selection (if any) already belongs to `parentId` —
	// an empty selection trivially agrees with any container.
	function sameContainerSelection(parentId: string): boolean {
		const ydoc = getYdoc();
		if (!ydoc || ids.size === 0) return true;
		const [firstId] = ids;
		return getRecord(ydoc, firstId)?.parentId === parentId;
	}

	function toggle(blockId: string, parentId: string): void {
		// Starting a fresh toggle-select in a different container than the
		// current selection replaces it outright — see the module comment above.
		if (!sameContainerSelection(parentId)) ids.clear();
		if (ids.has(blockId)) ids.delete(blockId);
		else ids.add(blockId);
		anchorId = blockId;
	}

	function extendRange(blockId: string, parentId: string, index: number): void {
		const ydoc = getYdoc();
		if (!ydoc) return;
		const currentAnchorId = anchorId && sameContainerSelection(parentId) ? anchorId : blockId;
		const siblings = listRecordsForParent(ydoc, parentId);
		const anchorIndex = siblings.findIndex((s) => s.id === currentAnchorId);
		if (anchorIndex === -1) {
			ids.clear();
			ids.add(blockId);
			anchorId = blockId;
			return;
		}
		const [lo, hi] = anchorIndex <= index ? [anchorIndex, index] : [index, anchorIndex];
		ids.clear();
		for (const sibling of siblings.slice(lo, hi + 1)) ids.add(sibling.id);
		anchorId = currentAnchorId;
	}

	function extendByKeyboard(blockId: string, direction: 'up' | 'down'): void {
		const ydoc = getYdoc();
		if (!ydoc) return;
		const record = getRecord(ydoc, blockId);
		if (!record) return;
		// Establish the anchor at the block the handle was focused on *before*
		// this keypress — without this, a first Shift+Arrow (no prior
		// selection) would fall through to extendRange's own "no anchor yet"
		// fallback, which anchors on its `blockId` argument. That argument is
		// the *target* row (siblings[nextIndex] below), so the selection would
		// collapse to that single row instead of spanning from where the user
		// started.
		if (!anchorId || !sameContainerSelection(record.parentId)) {
			anchorId = blockId;
		}
		const siblings = listRecordsForParent(ydoc, record.parentId);
		const currentIndex = siblings.findIndex((s) => s.id === blockId);
		if (currentIndex === -1) return;
		const nextIndex =
			direction === 'up'
				? Math.max(0, currentIndex - 1)
				: Math.min(siblings.length - 1, currentIndex + 1);
		extendRange(siblings[nextIndex].id, record.parentId, nextIndex);
		void focusDragHandle(siblings[nextIndex].id);
	}

	// The selected ids in their actual sibling order — needed so
	// duplicate/delete-as-group act in a stable, predictable order rather than
	// Set insertion order (which toggle's add/remove can scramble relative to
	// document order).
	function orderedSelection(): WorkspaceRecord[] {
		const ydoc = getYdoc();
		if (!ydoc || ids.size === 0) return [];
		const [firstId] = ids;
		const parentId = getRecord(ydoc, firstId)?.parentId;
		if (!parentId) return [];
		return listRecordsForParent(ydoc, parentId).filter((r) => ids.has(r.id));
	}

	function deleteSelection(): void {
		const ydoc = getYdoc();
		if (!ydoc) return;
		const selectedIds = orderedSelection().map((r) => r.id);
		if (selectedIds.length === 0) return;
		transactWithOrigin(ydoc, LOCAL_UI_ORIGIN, () => {
			for (const id of selectedIds) deleteRecord(ydoc, id);
		});
		clear();
	}

	function duplicateSelection(): void {
		const ydoc = getYdoc();
		if (!ydoc) return;
		const selectedIds = orderedSelection().map((r) => r.id);
		if (selectedIds.length === 0) return;
		const copies = transactWithOrigin(ydoc, LOCAL_UI_ORIGIN, () =>
			selectedIds.map((id) => duplicateRecord(ydoc, id, CURRENT_USER))
		);
		ids.clear();
		for (const copy of copies) ids.add(copy.id);
		anchorId = copies[0]?.id ?? null;
	}

	// Resolves the current selection's start/end position within its shared
	// parent's sibling list, or null when the selection is empty, spans an id
	// no longer found there, or isn't contiguous — "move a scattered set up"
	// has no single well-defined result. The one shared definition of "is this
	// selection movable as a unit," used by isContiguous, the bulk bar's Move
	// up/down disabled state, and moveAsGroup itself, so the three can't drift
	// out of agreement with each other.
	function resolveGroupBounds(): SelectionGroupBounds | null {
		const ydoc = getYdoc();
		if (!ydoc) return null;
		const selected = orderedSelection();
		if (selected.length === 0) return null;
		const siblings = listRecordsForParent(ydoc, selected[0].parentId);
		const indices = selected
			.map((r) => siblings.findIndex((s) => s.id === r.id))
			.filter((i) => i !== -1)
			.sort((a, b) => a - b);
		if (indices.length !== selected.length) return null;
		const groupStart = indices[0];
		const groupEnd = indices[indices.length - 1];
		if (groupEnd - groupStart + 1 !== indices.length) return null; // not contiguous
		return { siblings, groupStart, groupEnd };
	}

	function isContiguous(): boolean {
		return resolveGroupBounds() !== null;
	}

	// Whether the bulk bar's Move up/down button should be enabled — false for
	// a non-contiguous selection (see resolveGroupBounds) and also false right
	// at the container boundary in that direction, so the button can't be
	// clicked to silently do nothing.
	function canMoveAsGroup(direction: 'up' | 'down'): boolean {
		const bounds = resolveGroupBounds();
		if (!bounds) return false;
		return direction === 'up'
			? bounds.groupStart > 0
			: bounds.groupEnd < bounds.siblings.length - 1;
	}

	// Moves the whole selected group up/down by one position as a unit,
	// swapping it with its one adjacent unselected neighbor — the natural
	// generalization of a single block's own adjacent swap.
	function moveAsGroup(direction: 'up' | 'down'): void {
		const ydoc = getYdoc();
		if (!ydoc || !canMoveAsGroup(direction)) return;
		const { siblings, groupStart, groupEnd } = resolveGroupBounds()!;

		transactWithOrigin(ydoc, LOCAL_UI_ORIGIN, () => {
			if (direction === 'up') {
				reorderRecord(ydoc, siblings[groupStart - 1].id, siblings[groupEnd].id);
			} else {
				const beforeFirst = groupStart > 0 ? siblings[groupStart - 1].id : undefined;
				reorderRecord(ydoc, siblings[groupEnd + 1].id, beforeFirst);
			}
		});
		const count = groupEnd - groupStart + 1;
		const newStart = direction === 'up' ? groupStart - 1 : groupStart + 1;
		announceMoved(
			count === 1
				? `Moved block to position ${newStart + 1} of ${siblings.length}.`
				: `Moved ${count} blocks to positions ${newStart + 1}-${newStart + count} of ${siblings.length}.`
		);
	}

	return {
		get ids() {
			return ids;
		},
		get anchorId() {
			return anchorId;
		},
		clear,
		toggle,
		extendRange,
		extendByKeyboard,
		orderedSelection,
		deleteSelection,
		duplicateSelection,
		isContiguous,
		canMoveAsGroup,
		moveAsGroup
	};
}

export type BlockSelectionController = ReturnType<typeof createBlockSelection>;
