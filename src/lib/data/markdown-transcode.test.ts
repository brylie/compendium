import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { createDocument, deleteDocument } from '$lib/data/document-ops';
import { createCollection } from '$lib/data/collection-ops';
import { createDocument as serviceCreateDocument } from '$lib/services';
import { CURRENT_USER } from '$lib/server/current-user';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
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

	it('resolves [[Title]] to a Document only findable via the catalog fan-out (its own shard, #120)', () => {
		// Every Document created through the service layer lives in its own
		// shard, not the default doc — so resolving a wiki-link to it from a
		// different doc entirely must fall back to the catalog fan-out rather
		// than finding it via the target doc's own local Documents map.
		const target = serviceCreateDocument(CURRENT_USER, { title: 'Sharded Target Doc' });
		const { doc } = resolveWorkspaceContext();

		const richText = markdownToRichText(doc, 'see [[Sharded Target Doc]] for details');
		const linkRun = richText.runs.find((r) => r.marks.link?.startsWith('record:'));
		expect(linkRun?.marks.link).toBe(`record:${target.id}`);
	});

	it('resolves [[Title]] to a Collection when no Document matches', () => {
		const doc = new Y.Doc();
		const collection = createCollection(doc, { title: 'Sprint Backlog', schema: [] });

		const richText = markdownToRichText(doc, 'see [[Sprint Backlog]] for tasks');
		const linkRun = richText.runs.find((r) => r.marks.link?.startsWith('record:'));
		expect(linkRun?.marks.link).toBe(`record:${collection.id}`);

		const markdown = richTextToMarkdown(doc, richText);
		expect(markdown).toContain('[[Sprint Backlog]]');
	});

	it('normalizes @you to the same mention id as @local', () => {
		const doc = new Y.Doc();
		const richText = markdownToRichText(doc, 'ping @you please');
		const mentionRun = richText.runs.find((r) => r.marks.mention);
		expect(mentionRun?.marks.mention).toBe('local');
	});

	it('leaves a non-local @mention name as-is', () => {
		const doc = new Y.Doc();
		const richText = markdownToRichText(doc, 'ping @research-agent please');
		const mentionRun = richText.runs.find((r) => r.marks.mention);
		expect(mentionRun?.marks.mention).toBe('research-agent');
	});

	it('leaves a plain (non-record) link mark as an ordinary markdown link', () => {
		const doc = new Y.Doc();
		const richText: Parameters<typeof richTextToMarkdown>[1] = {
			runs: [{ text: 'docs', marks: { link: 'https://example.com' } }]
		};
		expect(richTextToMarkdown(doc, richText)).toBe('[docs](https://example.com)');
	});

	it('routes a leaf raw-HTML node through the unhandled-node-type fallback', () => {
		const doc = new Y.Doc();
		const richText = markdownToRichText(doc, 'before <br> after');
		expect(richText.runs.map((r) => r.text).join('')).toContain('before');
	});

	it('renders a wiki-link whose target Document was deleted as an explicit broken marker, not the stale title', () => {
		const doc = new Y.Doc();
		const document = createDocument(doc, { title: 'Q3 Roadmap' });
		const richText = markdownToRichText(doc, 'see [[Q3 Roadmap]] for details');
		const linkRun = richText.runs.find((r) => r.marks.link?.startsWith('record:'));
		expect(linkRun?.marks.link).toBe(`record:${document.id}`);

		deleteDocument(doc, document.id);

		const markdown = richTextToMarkdown(doc, richText);
		expect(markdown).toContain('[[Deleted page]]');
		expect(markdown).not.toContain('Q3 Roadmap');
	});
});
