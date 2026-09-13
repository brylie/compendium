import type * as Y from 'yjs';
import { richTextToMarkdown } from '$lib/data/markdown-transcode';
import { resolveParentWorkspaceContext } from '$lib/services/permissions';
import type { DocumentRecordData } from '$lib/services/documents';
import type {
	CalloutPreset,
	CalloutStyle,
	ChildPageNode,
	ChildPagesDepth,
	EmbeddedViewConfig
} from '$lib/data/types';

/**
 * Protocol-neutral markdown-rendered shape of one Document block/record.
 * Produced from `DocumentRecordData` (`$lib/services/documents.ts`) by
 * `projectDocumentRecordView` below.
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
	markdown: string;
	children?: DocumentRecordView[];
}

const CALLOUT_PRESET_ALERT_KEYWORD: Record<CalloutPreset, string> = {
	note: 'NOTE',
	tip: 'TIP',
	caution: 'CAUTION',
	danger: 'DANGER'
};

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

function renderCollectionViewMarkdown(data: DocumentRecordData): string {
	return data.referencedRecordId
		? `[collection view: ${data.linkedTargetTitle ?? 'Deleted collection'}]`
		: '[collection view: unconfigured]';
}

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
	const content = data.content ? richTextToMarkdown(doc, data.content) : '';
	if (data.blockType === 'callout' && data.calloutStyle?.kind === 'preset') {
		return renderPresetCalloutMarkdown(data.calloutStyle.preset, content);
	}
	return content;
}

/** Renders a DocumentRecordView block's markdown with its block-type prefix. */
export function renderBlockMarkdown(r: DocumentRecordView): string {
	switch (r.blockType) {
		case 'heading_1':
			return `# ${r.markdown}`;
		case 'heading_2':
			return `## ${r.markdown}`;
		case 'heading_3':
			return `### ${r.markdown}`;
		case 'heading_4':
			return `#### ${r.markdown}`;
		case 'bulleted_list_item':
			return `- ${r.markdown}`;
		case 'numbered_list_item':
			return `1. ${r.markdown}`;
		case 'to_do':
			return `- [${r.checked ? 'x' : ' '}] ${r.markdown}`;
		case 'quote':
			return `> ${r.markdown}`;
		case 'code':
			return `\`\`\`\n${r.markdown}\n\`\`\``;
		case 'divider':
			return `---`;
		default:
			return r.markdown;
	}
}

function renderColumnMarkdown(column: DocumentRecordView): string {
	const body = (column.children ?? [])
		.map((block) => renderBlockMarkdown(block))
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
 * `services/documents.ts#getDocument`) to `DocumentRecordView`.
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
		markdown,
		children
	};
}

/**
 * Renders a full `getDocument` result (protocol-neutral) into a projected document view.
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
