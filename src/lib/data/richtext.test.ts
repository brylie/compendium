import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyRichTextToYText, plainText, yTextToRichText } from './richtext';

describe('richtext: Y.Text <-> RichText conversion', () => {
	it('round-trips runs with marks through a doc-attached Y.Text', () => {
		const doc = new Y.Doc();
		const ytext = doc.getText('t');
		applyRichTextToYText(ytext, { runs: [{ text: 'hello', marks: { bold: true } }] });
		expect(yTextToRichText(ytext)).toEqual({ runs: [{ text: 'hello', marks: { bold: true } }] });
	});

	it('skips empty-text runs instead of inserting a zero-length span', () => {
		const doc = new Y.Doc();
		const ytext = doc.getText('t');
		applyRichTextToYText(ytext, {
			runs: [
				{ text: '', marks: { bold: true } },
				{ text: 'kept', marks: {} }
			]
		});
		expect(plainText(yTextToRichText(ytext))).toBe('kept');
	});

	it('replaces existing content rather than appending', () => {
		const doc = new Y.Doc();
		const ytext = doc.getText('t');
		applyRichTextToYText(ytext, { runs: [{ text: 'first', marks: {} }] });
		applyRichTextToYText(ytext, { runs: [{ text: 'second', marks: {} }] });
		expect(plainText(yTextToRichText(ytext))).toBe('second');
	});

	it('applies directly, without wrapping in a transaction, when the Y.Text has no owning doc yet', () => {
		const ytext = new Y.Text();
		expect(ytext.doc).toBeFalsy();
		// A Y.Text not yet integrated into a doc can't durably store content, but
		// applyRichTextToYText must still take the doc-less path without throwing
		// (the real, integrated case is exercised by every other test here).
		expect(() => applyRichTextToYText(ytext, { runs: [{ text: 'x', marks: {} }] })).not.toThrow();
	});
});

describe('plainText', () => {
	it('joins all run text with no separator', () => {
		expect(
			plainText({
				runs: [
					{ text: 'hello ', marks: {} },
					{ text: 'world', marks: { bold: true } }
				]
			})
		).toBe('hello world');
	});
});
