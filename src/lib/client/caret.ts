/** Character offset (within root's text content) of the caret / selection start. */
export function getCaretOffset(root: HTMLElement): number {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return 0;
	const range = selection.getRangeAt(0);
	if (!root.contains(range.startContainer)) return 0;
	const preRange = range.cloneRange();
	preRange.selectNodeContents(root);
	preRange.setEnd(range.startContainer, range.startOffset);
	return preRange.toString().length;
}

/** Character offsets (within root's text content) of the current selection's start and end, or null if there's no selection inside root. */
export function getSelectionOffsets(root: HTMLElement): { start: number; end: number } | null {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return null;
	const range = selection.getRangeAt(0);
	if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;

	const preStart = range.cloneRange();
	preStart.selectNodeContents(root);
	preStart.setEnd(range.startContainer, range.startOffset);

	const preEnd = range.cloneRange();
	preEnd.selectNodeContents(root);
	preEnd.setEnd(range.endContainer, range.endOffset);

	return { start: preStart.toString().length, end: preEnd.toString().length };
}

/** Collapses the selection to a caret at the given character offset within root's text content. */
export function setCaretOffset(root: HTMLElement, offset: number): void {
	const selection = window.getSelection();
	if (!selection) return;
	const { node, offset: nodeOffset } = findNodeAtOffset(root, offset);
	const range = document.createRange();
	if (node) {
		range.setStart(node, nodeOffset);
	} else {
		range.selectNodeContents(root);
		range.collapse(false);
	}
	range.collapse(true);
	selection.removeAllRanges();
	selection.addRange(range);
}

// Neither method is guaranteed: jsdom (this repo's test environment) implements
// neither on Range at all, and a collapsed range can legitimately report a
// zero-size rect even in a real browser. Callers treat a null return as "can't
// tell" and fall back to sensible non-geometric behavior.
function getCollapsedRangeRect(range: Range): DOMRect | null {
	if (typeof range.getClientRects === 'function') {
		const rects = range.getClientRects();
		if (rects.length > 0) return rects[0];
	}
	if (typeof range.getBoundingClientRect === 'function') {
		return range.getBoundingClientRect();
	}
	return null;
}

/** Client-rect x coordinate of the caret, or null if there's no collapsible selection. */
export function getCaretClientX(root: HTMLElement): number | null {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0 || !root.contains(selection.anchorNode)) {
		return null;
	}
	const range = selection.getRangeAt(0).cloneRange();
	range.collapse(true);
	const rect = getCollapsedRangeRect(range);
	if (!rect || (rect.width === 0 && rect.height === 0 && rect.left === 0)) return null;
	return rect.left;
}

// Blocks hold plain (non-`\n`-delimited) rich text that soft-wraps, so there's
// no line data to query directly — geometry is the only way to tell whether
// the caret is on the editor's visually-topmost/bottommost wrapped line, which
// is what "at the top/bottom edge, let ArrowUp/ArrowDown escape to the
// previous/next block" means for a multi-line paragraph.
function isCaretAtEdge(root: HTMLElement, edge: 'first' | 'last'): boolean {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0 || !root.contains(selection.anchorNode)) {
		return true;
	}
	const original = selection.getRangeAt(0);
	// A ranged (non-collapsed) selection must keep the browser's native
	// Arrow-key behavior (collapse to one end) — treating it as "at the
	// edge" here would replace the user's selection with a caret in an
	// adjacent block instead.
	if (!original.collapsed) return false;
	const range = original.cloneRange();
	range.collapse(true);
	const caretRect = getCollapsedRangeRect(range);
	if (!caretRect || caretRect.height === 0) return true;
	const rootRect = root.getBoundingClientRect();
	return edge === 'first'
		? caretRect.top - rootRect.top < caretRect.height / 2
		: rootRect.bottom - caretRect.bottom < caretRect.height / 2;
}

/** True when the caret sits on root's visual first line — the boundary an ArrowUp at the top should cross into the previous block. */
export function isCaretAtFirstLine(root: HTMLElement): boolean {
	return isCaretAtEdge(root, 'first');
}

/** True when the caret sits on root's visual last line — the boundary an ArrowDown at the bottom should cross into the next block. */
export function isCaretAtLastLine(root: HTMLElement): boolean {
	return isCaretAtEdge(root, 'last');
}

/**
 * Positions the caret on root's first/last visual line, as close as possible
 * to clientX — the column-preserving landing spot for a block-to-block
 * ArrowUp/ArrowDown move. Falls back to the block's start/end when point-based
 * hit-testing isn't available (e.g. jsdom) or misses the element entirely.
 */
export function setCaretNearClientX(
	root: HTMLElement,
	clientX: number | null,
	edge: 'first' | 'last'
): void {
	root.focus();
	const y = clientX !== null ? getEdgeLineY(root, edge) : null;
	if (clientX !== null && y !== null) {
		const doc = root.ownerDocument;
		let range: Range | null = null;
		// caretRangeFromPoint is deprecated/non-standard, but still the most
		// broadly-supported point-based hit-testing API — caretPositionFromPoint
		// (the standards-track replacement) is the fallback below for browsers
		// that lack it, not a reason to drop the primary path.
		// eslint-disable-next-line sonarjs/deprecation
		if (typeof doc.caretRangeFromPoint === 'function') {
			// eslint-disable-next-line sonarjs/deprecation
			range = doc.caretRangeFromPoint(clientX, y);
		} else if (typeof doc.caretPositionFromPoint === 'function') {
			const pos = doc.caretPositionFromPoint(clientX, y);
			if (pos) {
				range = document.createRange();
				range.setStart(pos.offsetNode, pos.offset);
			}
		}
		if (range && root.contains(range.startContainer)) {
			range.collapse(true);
			const selection = window.getSelection();
			selection?.removeAllRanges();
			selection?.addRange(range);
			return;
		}
	}
	setCaretOffset(root, edge === 'first' ? 0 : (root.textContent?.length ?? 0));
}

// The vertical center of root's actual first/last visual line, measured from
// the real text node at that edge — not guessed as a fraction of the block's
// total height, which lands on an interior line for any block wrapped across
// more than a couple of lines. Returns null when there's no text to measure
// (empty block) or no usable geometry (e.g. jsdom).
function getEdgeLineY(root: HTMLElement, edge: 'first' | 'last'): number | null {
	const length = root.textContent?.length ?? 0;
	const { node, offset } = findNodeAtOffset(root, edge === 'first' ? 0 : length);
	if (!node) return null;
	const range = document.createRange();
	range.setStart(node, offset);
	range.collapse(true);
	const rect = getCollapsedRangeRect(range);
	if (!rect || rect.height === 0) return null;
	return rect.top + rect.height / 2;
}

function findNodeAtOffset(root: Node, offset: number): { node: Node | null; offset: number } {
	let remaining = offset;
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let node: Node | null;
	while ((node = walker.nextNode())) {
		const len = node.textContent?.length ?? 0;
		if (remaining <= len) return { node, offset: remaining };
		remaining -= len;
	}
	return { node: null, offset: 0 };
}
