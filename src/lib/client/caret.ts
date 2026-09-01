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
	const range = selection.getRangeAt(0).cloneRange();
	range.collapse(true);
	const caretRect = getCollapsedRangeRect(range);
	if (!caretRect || caretRect.height === 0) return true;
	const rootRect = root.getBoundingClientRect();
	return edge === 'first'
		? caretRect.top - rootRect.top < caretRect.height / 2
		: rootRect.bottom - caretRect.bottom < caretRect.height / 2;
}

export function isCaretAtFirstLine(root: HTMLElement): boolean {
	return isCaretAtEdge(root, 'first');
}

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
	if (clientX !== null) {
		const rect = root.getBoundingClientRect();
		const lineFraction = 0.1;
		const y =
			edge === 'first'
				? rect.top + rect.height * lineFraction
				: rect.bottom - rect.height * lineFraction;
		const doc = root.ownerDocument;
		let range: Range | null = null;
		if (typeof doc.caretRangeFromPoint === 'function') {
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
