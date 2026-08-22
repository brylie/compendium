export interface TextDiff {
	start: number;
	deleteCount: number;
	insertText: string;
}

/** Smallest edit (common-prefix/common-suffix) turning oldText into newText. */
export function diffPlainText(oldText: string, newText: string): TextDiff {
	let start = 0;
	const maxStart = Math.min(oldText.length, newText.length);
	while (start < maxStart && oldText[start] === newText[start]) start++;

	let oldEnd = oldText.length;
	let newEnd = newText.length;
	while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
		oldEnd--;
		newEnd--;
	}

	return { start, deleteCount: oldEnd - start, insertText: newText.slice(start, newEnd) };
}
