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
