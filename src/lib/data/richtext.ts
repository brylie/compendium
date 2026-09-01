import * as Y from 'yjs';
import type { RichText, TextMarks } from './types';

/**
 * The RichText.runs shape is derived from Y.Text on read, not stored
 * separately — Y.Text.format() already stores marks as attribute ranges
 * and merges concurrent overlapping formatting correctly (technical-design.md §3).
 */
export function yTextToRichText(ytext: Y.Text): RichText {
	const delta = ytext.toDelta() as { insert: string; attributes?: TextMarks }[];
	return {
		runs: delta.map((d) => ({ text: d.insert, marks: d.attributes ?? {} }))
	};
}

/** Whole-block replace: used by MCP writes, which arrive as a finished block, not keystrokes. */
export function applyRichTextToYText(ytext: Y.Text, richText: RichText): void {
	const apply = () => {
		ytext.delete(0, ytext.length);
		let offset = 0;
		for (const run of richText.runs) {
			if (!run.text) continue;
			ytext.insert(offset, run.text, run.marks as Record<string, unknown>);
			offset += run.text.length;
		}
	};
	if (ytext.doc) {
		ytext.doc.transact(apply);
	} else {
		apply();
	}
}

/**
 * Appends a RichText onto the end of an existing Y.Text, preserving both
 * sides' marks — unlike applyRichTextToYText, it does not clear ytext
 * first. Used for Backspace-at-the-start-of-a-block joining that block's
 * text onto the end of the previous one, the word-processor "backspace
 * merges this line into the line above" behavior.
 */
export function appendRichTextToYText(ytext: Y.Text, richText: RichText): void {
	const apply = () => {
		let offset = ytext.length;
		for (const run of richText.runs) {
			if (!run.text) continue;
			ytext.insert(offset, run.text, run.marks as Record<string, unknown>);
			offset += run.text.length;
		}
	};
	if (ytext.doc) {
		ytext.doc.transact(apply);
	} else {
		apply();
	}
}

/** Concatenates a RichText's runs into a single plain string, discarding all marks. */
export function plainText(richText: RichText): string {
	return richText.runs.map((r) => r.text).join('');
}

/**
 * Splits a RichText at a plain-text character offset, dividing a run in two
 * (each half keeping the original marks) when the offset falls inside it.
 * Used for Enter-splits-a-block: the text after the caret becomes a new
 * block rather than being silently discarded.
 */
export function splitRichTextAt(
	richText: RichText,
	offset: number
): { before: RichText; after: RichText } {
	const before: RichText['runs'] = [];
	const after: RichText['runs'] = [];
	let pos = 0;
	for (const run of richText.runs) {
		const runEnd = pos + run.text.length;
		if (runEnd <= offset) {
			before.push(run);
		} else if (pos >= offset) {
			after.push(run);
		} else {
			const splitAt = offset - pos;
			before.push({ text: run.text.slice(0, splitAt), marks: run.marks });
			after.push({ text: run.text.slice(splitAt), marks: run.marks });
		}
		pos = runEnd;
	}
	return { before: { runs: before }, after: { runs: after } };
}
