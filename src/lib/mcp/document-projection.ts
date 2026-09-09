import type * as Y from 'yjs';
import { richTextToMarkdown } from '$lib/data/markdown-transcode';
import { resolveParentWorkspaceContext } from '$lib/services/permissions';
import type { DocumentRecordData } from '$lib/services/documents';
import type {
	BookmarkMetadata,
	CalloutPreset,
	CalloutStyle,
	ChildPageNode,
	ChildPagesDepth,
	EmbeddedViewConfig
} from '$lib/data/types';

/**
 * MCP-facing, markdown-rendered shape of one Document block/record — what
 * `get_document` actually returns to a client. Produced from the
 * protocol-neutral `DocumentRecordData` (`$lib/services/documents.ts`) by
 * `projectDocumentRecordView` below; `services/documents.ts#getDocument`
 * itself does no markdown rendering (#191) — that's this module's job, since
 * only the MCP tool surface needs a markdown string at all.
 */
export interface DocumentRecordView {
	id: string;
	blockType?: string;
	checked?: boolean;
	collapsed?: boolean;
	referencedRecordId?: string;
	linkBroken?: boolean;
	viewConfig?: EmbeddedViewConfig;
	calloutStyle?: CalloutStyle;
	childPagesDepth?: ChildPagesDepth;
	url?: string;
	bookmarkMetadata?: BookmarkMetadata;
	markdown: string;
	// Present only on a container block (columns/column, issue #148) — its
	// own children, each projected the same recursive way. A columns
	// block's `markdown` already folds its columns' children in as fenced
	// `::: column` sections (see renderColumnsMarkdown below); this is
	// exposed separately too so a caller that wants structured per-block
	// fields (checked/collapsed/viewConfig/...) for something nested inside
	// a column doesn't have to re-parse markdown to get them.
	children?: DocumentRecordView[];
}

// GitHub's `> [!NOTE]` alert-blockquote syntax is the nearest existing
// convention (issue #42 names it explicitly) — reused here for the four
// presets' *keyword*, not adopted wholesale: GitHub itself only defines
// NOTE/TIP/IMPORTANT/WARNING/CAUTION, not our "danger", and this repo has no
// blockquote parser at all (markdown-transcoding.md is scoped to inline
// Y.Text <-> Markdown only) — so this is read-direction only. A custom
// callout has no markdown representation (an arbitrary color has no
// alert-syntax equivalent) and renders as plain content, same as before this
// feature; see markdown-transcoding.md's callout section for the full
// decision writeup.
const CALLOUT_PRESET_ALERT_KEYWORD: Record<CalloutPreset, string> = {
	note: 'NOTE',
	tip: 'TIP',
	caution: 'CAUTION',
	danger: 'DANGER'
};

// Nested markdown bullets of `[[Title]]` wiki-links, one per resolved child
// (issue #43) — matching page_link's own `[[Title]]` convention rather than
// inventing a second link syntax, and fully expressible in plain Markdown
// (unlike collection_view's viewConfig, this resolved listing needs no
// separate structured field — see markdown-transcoding.md). Read-direction
// only, same as every other block-level markdown emission in this file: no
// parser turns a `- [[Title]]` list back into childPagesDepth/referencedRecordId.
function renderChildPagesMarkdown(nodes: ChildPageNode[], depth = 0): string {
	if (nodes.length === 0) return depth === 0 ? '_No sub-pages yet._' : '';
	return nodes
		.map((n) => {
			const line = `${'  '.repeat(depth)}- [[${n.title || 'Untitled'}]]`;
			const childLines = renderChildPagesMarkdown(n.children, depth + 1);
			return childLines ? `${line}\n${childLines}` : line;
		})
		.join('\n');
}

function renderPageLinkMarkdown(data: DocumentRecordData, doc: Y.Doc): string {
	if (data.referencedRecordId) {
		return `[[${data.linkedTargetTitle ?? 'Deleted page'}]]`;
	}
	return data.content ? richTextToMarkdown(doc, data.content) : '';
}

// Escapes the characters that would otherwise break `[label](url)` syntax —
// a minimal escape, not the full inline-mark escaping richTextToMarkdown's
// own escapeMarkdown does, since a bookmark's title is plain scraped text
// with no marks of its own to preserve.
function escapeBookmarkLabel(text: string): string {
	return text.replace(/\\/g, '\\\\').replace(/[[\]]/g, (c) => `\\${c}`);
}

// A real Markdown link, not a bracketed placeholder like page_link's `[[Title]]`
// or collection_view's `[collection view: ...]` — a bookmark's target is a
// genuine external URL, so `[Title](url)` already *is* the graceful plain-link
// fallback the PRD requires (issue #155): any Markdown renderer that doesn't
// know about rich preview cards still shows a normal, clickable link, whether
// the fetch that would populate Title succeeded, is still pending, or failed.
function renderBookmarkMarkdown(data: DocumentRecordData): string {
	if (!data.url) return '[bookmark: unconfigured]';
	const trimmedTitle = data.bookmarkMetadata?.title?.trim();
	const label = trimmedTitle && trimmedTitle.length > 0 ? trimmedTitle : data.url;
	return `[${escapeBookmarkLabel(label)}](${data.url})`;
}

function renderCollectionViewMarkdown(data: DocumentRecordData): string {
	return data.referencedRecordId
		? `[collection view: ${data.linkedTargetTitle ?? 'Deleted collection'}]`
		: '[collection view: unconfigured]';
}

// One generic "unavailable" placeholder for both "target was deleted" and
// "target exists but is out of this caller's scope" — deliberately not
// distinguished, the same anti-oracle principle InvalidLinkTargetError's own
// single error message already applies to page_link's write-side target
// validation (services/records.ts). `hasConfiguredTarget` (raw, unscoped) is
// what tells this apart from "never configured" — `referencedRecordId`/
// `linkedTargetTitle` are both undefined in either case.
function renderChildPagesBlockMarkdown(data: DocumentRecordData): string {
	if (data.hasConfiguredTarget && data.linkedTargetTitle === undefined) {
		return '[child pages: unavailable]';
	}
	return renderChildPagesMarkdown(data.childPages ?? []);
}

function renderRecordMarkdown(
	data: DocumentRecordData,
	doc: Y.Doc,
	isPageLink: boolean,
	isCollectionView: boolean,
	isChildPages: boolean
): string {
	if (isPageLink) return renderPageLinkMarkdown(data, doc);
	if (isCollectionView) return renderCollectionViewMarkdown(data);
	if (isChildPages) return renderChildPagesBlockMarkdown(data);
	if (data.blockType === 'bookmark') return renderBookmarkMarkdown(data);
	const content = data.content ? richTextToMarkdown(doc, data.content) : '';
	if (data.blockType === 'callout' && data.calloutStyle?.kind === 'preset') {
		return renderPresetCalloutMarkdown(data.calloutStyle.preset, content);
	}
	return content;
}

// Pandoc-style fenced-div syntax (`::: name`) — the nearest existing plain-
// markdown convention for "a named container of block content," and, like
// callout's GitHub alert syntax above, read-direction only: there is no
// parser turning `::: columns` back into a columns block/columnCount (an
// agent adds/removes columns and their content the ordinary way, via
// create_record/write_record/delete_record on the columns block's own
// children — see mcp-tools.md). An empty column still renders its own
// `::: column\n:::` pair so a caller can tell "N columns, some empty" apart
// from "fewer columns than columnCount requested."
function renderColumnMarkdown(column: DocumentRecordView): string {
	const body = (column.children ?? [])
		.map((block) => block.markdown)
		.filter((markdown) => markdown.length > 0)
		.join('\n\n');
	return body ? `::: column\n${body}\n:::` : '::: column\n:::';
}

function renderColumnsMarkdown(columns: DocumentRecordView[]): string {
	return ['::: columns', ...columns.map(renderColumnMarkdown), ':::'].join('\n');
}

function renderPresetCalloutMarkdown(preset: CalloutPreset, content: string): string {
	const keyword = CALLOUT_PRESET_ALERT_KEYWORD[preset];
	if (!content) return `> [!${keyword}]`;
	const quotedLines = content
		.split('\n')
		.map((line) => `> ${line}`)
		.join('\n');
	return `> [!${keyword}]\n${quotedLines}`;
}

/**
 * Renders one protocol-neutral `DocumentRecordData` (from
 * `services/documents.ts#getDocument`) to the markdown-shaped
 * `DocumentRecordView` MCP clients see. `doc` is needed only for
 * `richTextToMarkdown`'s inline `[[wiki-link]]` title resolution — get it via
 * `resolveParentWorkspaceContext` (the same helper `getDocument` itself
 * already used to resolve the Document's own shard), not by threading a
 * `Y.Doc` handle through `getDocument`'s protocol-neutral return value.
 */
export function projectDocumentRecordView(
	data: DocumentRecordData,
	doc: Y.Doc
): DocumentRecordView {
	const isPageLink = data.blockType === 'page_link';
	const isCollectionView = data.blockType === 'collection_view';
	const isChildPages = data.blockType === 'child_pages';
	const children = data.children?.map((child) => projectDocumentRecordView(child, doc));
	const markdown =
		data.blockType === 'columns' && children
			? renderColumnsMarkdown(children)
			: renderRecordMarkdown(data, doc, isPageLink, isCollectionView, isChildPages);
	return {
		id: data.id,
		blockType: data.blockType,
		checked: data.checked,
		collapsed: data.collapsed,
		referencedRecordId: data.referencedRecordId,
		linkBroken: data.linkBroken,
		viewConfig: data.viewConfig,
		calloutStyle: data.calloutStyle,
		childPagesDepth: data.childPagesDepth,
		url: data.url,
		bookmarkMetadata: data.bookmarkMetadata,
		markdown,
		children
	};
}

/**
 * Renders a full `getDocument` result (protocol-neutral) into the
 * markdown-shaped response the `get_document` MCP tool returns — the one
 * place `services/documents.ts#getDocument`'s output actually becomes
 * markdown, per #191's "application queries return protocol-neutral models,
 * MCP/presentation adapter renders" split.
 */
export function projectDocument(
	documentId: string,
	data: { id: string; title: string; parentDocumentId?: string; records: DocumentRecordData[] }
): { id: string; title: string; parentDocumentId?: string; records: DocumentRecordView[] } {
	const { doc } = resolveParentWorkspaceContext(documentId);
	return {
		id: data.id,
		title: data.title,
		parentDocumentId: data.parentDocumentId,
		records: data.records.map((record) => projectDocumentRecordView(record, doc))
	};
}
