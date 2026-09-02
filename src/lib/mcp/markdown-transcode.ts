import { remark } from 'remark';
import remarkGfm from 'remark-gfm';
import type * as Y from 'yjs';
import { listCollections, listDocuments } from '$lib/data/records';
import { RECORD_LINK_SCHEME, resolveInternalLinkTarget } from '$lib/data/links';
import { resolveParentWorkspaceContext } from '$lib/services/permissions';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { listCatalogCollections, listCatalogDocuments } from '$lib/server/catalog';
import type { RichText, TextMarks } from '$lib/data/types';

// Per docs/technical-design.md §6: CommonMark + GFM as the baseline, plus two
// workspace-specific extensions Markdown has no syntax for — @mention and
// [[Record Title]] wiki-links for relation-typed links. A [[...]] link is
// represented internally as an ordinary `link` mark whose href uses a
// `record:` scheme, so the rich-text model doesn't need a dedicated mark
// type for it.

// The wiki-link body is bounded to 500 chars (far beyond any real
// Document/Collection title) rather than left unbounded ([^\]]+): an
// unbounded body means every unclosed "[[" in the input — e.g. pasted text
// containing many "[[" sequences with no matching "]]" — forces the engine
// to scan to the end of the string and backtrack one character at a time
// before giving up, for every single one of those starting positions. That's
// quadratic in input length, not linear, on content this function has to
// run over untrusted document/MCP-write text. Bounding the body caps the
// worst case per position to a constant instead.
const SPECIAL_TOKEN = /(@[\w-]+)|(\[\[[^\]]{1,500}\]\])/g;

// Rendered in place of the target's title when a wiki-link's target ID no
// longer resolves to any Document/Collection (see docs/specifications/
// internal-links.md) — deliberately not the stale cached title, which would
// silently mislabel a broken link as a working one.
const DELETED_LINK_LABEL = 'Deleted page';

interface MutableRun {
	text: string;
	marks: TextMarks;
}

// ---------------------------------------------------------------------------
// RichText -> Markdown
// ---------------------------------------------------------------------------

/** Serializes a block's RichText model to Markdown (the Y.Text ⇄ Markdown boundary, see markdown-transcoding.md). */
export function richTextToMarkdown(doc: Y.Doc, richText: RichText): string {
	return richText.runs.map((run) => runToMarkdown(doc, run.text, run.marks)).join('');
}

function runToMarkdown(doc: Y.Doc, text: string, marks: TextMarks): string {
	if (marks.mention) return `@${text}`;
	if (marks.link?.startsWith(RECORD_LINK_SCHEME)) {
		const id = marks.link.slice(RECORD_LINK_SCHEME.length);
		// A wiki-link target's own shard (#120: Documents and Collections both
		// have one) may or may not be `doc` itself. Try `doc` first — cheap,
		// and correct whenever the target really is local to it — then fall
		// back to resolving its real shard.
		const target =
			resolveInternalLinkTarget(doc, id) ??
			resolveInternalLinkTarget(resolveParentWorkspaceContext(id).doc, id);
		return `[[${target?.title ?? DELETED_LINK_LABEL}]]`;
	}

	let out = escapeMarkdown(text);
	if (marks.code) out = `\`${out}\``;
	if (marks.bold) out = `**${out}**`;
	if (marks.italic) out = `_${out}_`;
	if (marks.strikethrough) out = `~~${out}~~`;
	if (marks.link) out = `[${out}](${marks.link})`;
	return out;
}

function escapeMarkdown(text: string): string {
	return text.replace(/([\\`*_{}[\]()#+\-.!~])/g, '\\$1');
}

// ---------------------------------------------------------------------------
// Markdown -> RichText
// ---------------------------------------------------------------------------

interface MdastNode {
	type: string;
	value?: string;
	url?: string;
	children?: MdastNode[];
}

/** Parses Markdown into the RichText model (the reverse of {@link richTextToMarkdown}), resolving mentions and [[wiki-links]] against `doc`. */
export function markdownToRichText(doc: Y.Doc, markdown: string): RichText {
	const tree = remark().use(remarkGfm).parse(markdown) as unknown as MdastNode;
	const runs: MutableRun[] = [];
	collectRuns(doc, tree, {}, runs);
	return { runs: runs.filter((r) => r.text.length > 0) };
}

function collectRuns(doc: Y.Doc, node: MdastNode, marks: TextMarks, runs: MutableRun[]): void {
	switch (node.type) {
		case 'text':
			splitSpecialTokens(doc, node.value ?? '', marks, runs);
			return;
		case 'strong':
			for (const c of node.children ?? []) collectRuns(doc, c, { ...marks, bold: true }, runs);
			return;
		case 'emphasis':
			for (const c of node.children ?? []) collectRuns(doc, c, { ...marks, italic: true }, runs);
			return;
		case 'delete':
			for (const c of node.children ?? [])
				collectRuns(doc, c, { ...marks, strikethrough: true }, runs);
			return;
		case 'inlineCode':
			runs.push({ text: node.value ?? '', marks: { ...marks, code: true } });
			return;
		case 'link':
			for (const c of node.children ?? []) collectRuns(doc, c, { ...marks, link: node.url }, runs);
			return;
		default:
			for (const c of node.children ?? []) collectRuns(doc, c, marks, runs);
			if (!node.children && node.value) splitSpecialTokens(doc, node.value, marks, runs);
	}
}

function splitSpecialTokens(doc: Y.Doc, text: string, marks: TextMarks, runs: MutableRun[]): void {
	let lastIndex = 0;
	for (const match of text.matchAll(SPECIAL_TOKEN)) {
		const index = match.index ?? 0;
		if (index > lastIndex) runs.push({ text: text.slice(lastIndex, index), marks });

		if (match[1]) {
			const name = match[1].slice(1);
			runs.push({ text: name, marks: { ...marks, mention: resolveMentionId(name) } });
		} else if (match[2]) {
			const title = match[2].slice(2, -2);
			const recordId = resolveTitleToId(doc, title);
			runs.push({
				text: title,
				marks: recordId ? { ...marks, link: RECORD_LINK_SCHEME + recordId } : marks
			});
		}
		lastIndex = index + match[0].length;
	}
	if (lastIndex < text.length) runs.push({ text: text.slice(lastIndex), marks });
}

function resolveMentionId(name: string): string {
	const lower = name.toLowerCase();
	if (lower === 'local' || lower === 'you') return 'local';
	return name;
}

function resolveTitleToId(doc: Y.Doc, title: string): string | undefined {
	// Try `doc`'s own Documents/Collections first (cheap, and correct whenever
	// the target really is local to it), then fall back to the catalog —
	// always complete regardless of which shard each Document/Collection's
	// content lives in, unlike `doc`'s own maps once each has its own shard (#120).
	const localDocumentMatch = listDocuments(doc).find((d) => d.title === title)?.id;
	if (localDocumentMatch) return localDocumentMatch;
	const localCollectionMatch = listCollections(doc).find((c) => c.title === title)?.id;
	if (localCollectionMatch) return localCollectionMatch;
	const { workspaceId } = resolveWorkspaceContext();
	const catalogDocumentMatch = listCatalogDocuments(workspaceId).find((d) => d.title === title)?.id;
	if (catalogDocumentMatch) return catalogDocumentMatch;
	return listCatalogCollections(workspaceId).find((c) => c.title === title)?.id;
}
