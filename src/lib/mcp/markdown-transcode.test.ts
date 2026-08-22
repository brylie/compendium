import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createDocument } from '$lib/data/records';
import { markdownToRichText, richTextToMarkdown } from './markdown-transcode';

describe('markdown transcoding', () => {
	it('round-trips CommonMark inline formatting', () => {
		const doc = new Y.Doc();
		const markdown =
			'plain **bold** and _italic_ and `code` and ~~gone~~ and [link](https://example.com)';
		const richText = markdownToRichText(doc, markdown);

		expect(richText.runs.some((r) => r.marks.bold)).toBe(true);
		expect(richText.runs.some((r) => r.marks.italic)).toBe(true);
		expect(richText.runs.some((r) => r.marks.code)).toBe(true);
		expect(richText.runs.some((r) => r.marks.strikethrough)).toBe(true);
		expect(richText.runs.some((r) => r.marks.link === 'https://example.com')).toBe(true);

		const backToMarkdown = richTextToMarkdown(doc, richText);
		expect(markdownToRichText(doc, backToMarkdown)).toEqual(richText);
	});

	it('parses @mention into a mention-marked run', () => {
		const doc = new Y.Doc();
		const richText = markdownToRichText(doc, 'ping @local please');
		const mentionRun = richText.runs.find((r) => r.marks.mention);
		expect(mentionRun).toMatchObject({ text: 'local', marks: { mention: 'local' } });
	});

	it('resolves [[Record Title]] to a record: link mark and back to the current title', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Q3 Roadmap' });

		const richText = markdownToRichText(doc, 'see [[Q3 Roadmap]] for details');
		const linkRun = richText.runs.find((r) => r.marks.link?.startsWith('record:'));
		expect(linkRun?.marks.link).toBe(`record:${document.id}`);

		const markdown = richTextToMarkdown(doc, richText);
		expect(markdown).toContain('[[Q3 Roadmap]]');
	});

	it('leaves an unresolvable [[Title]] as plain, unlinked text', () => {
		const doc = new Y.Doc();
		const richText = markdownToRichText(doc, 'see [[Nonexistent]] here');
		expect(richText.runs.some((r) => r.marks.link)).toBe(false);
		expect(richText.runs.map((r) => r.text).join('')).toContain('Nonexistent');
	});
});
