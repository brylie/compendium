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

export function plainText(richText: RichText): string {
	return richText.runs.map((r) => r.text).join('');
}
