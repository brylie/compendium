import {
	Bold,
	Code,
	Copy,
	FileCode,
	Heading1,
	Heading2,
	Heading3,
	Heading4,
	Italic,
	Link,
	Link2,
	List,
	ListCollapse,
	ListOrdered,
	ListTodo,
	MessageSquareWarning,
	Minus,
	PanelsTopLeft,
	Quote,
	Strikethrough,
	Table2,
	TableOfContents,
	Type
} from '@lucide/svelte';
import type { LucideIcon } from '@lucide/svelte';
import type { BlockType, TextMarks } from '$lib/data/types';

export type ToolbarControl =
	| {
			id: string;
			group: 'format';
			label: string;
			icon: LucideIcon;
			mark: keyof TextMarks;
	  }
	| {
			id: string;
			group: 'insert';
			label: string;
			icon: LucideIcon;
			blockType: BlockType;
	  };

// This is the toolbar extension point. A future action only needs one
// self-contained registration here; Toolbar.svelte does not need a new branch
// or layout change for every button.
export const TOOLBAR_CONTROLS: readonly ToolbarControl[] = [
	{ id: 'bold', group: 'format', label: 'Bold', icon: Bold, mark: 'bold' },
	{ id: 'italic', group: 'format', label: 'Italic', icon: Italic, mark: 'italic' },
	{
		id: 'strikethrough',
		group: 'format',
		label: 'Strikethrough',
		icon: Strikethrough,
		mark: 'strikethrough'
	},
	{ id: 'inline-code', group: 'format', label: 'Inline code', icon: Code, mark: 'code' },
	{ id: 'link', group: 'format', label: 'Link', icon: Link, mark: 'link' },
	{ id: 'paragraph', group: 'insert', label: 'Text', icon: Type, blockType: 'paragraph' },
	{
		id: 'heading-1',
		group: 'insert',
		label: 'Heading 1',
		icon: Heading1,
		blockType: 'heading_1'
	},
	{
		id: 'heading-2',
		group: 'insert',
		label: 'Heading 2',
		icon: Heading2,
		blockType: 'heading_2'
	},
	{
		id: 'heading-3',
		group: 'insert',
		label: 'Heading 3',
		icon: Heading3,
		blockType: 'heading_3'
	},
	{
		id: 'heading-4',
		group: 'insert',
		label: 'Heading 4',
		icon: Heading4,
		blockType: 'heading_4'
	},
	{
		id: 'bulleted-list',
		group: 'insert',
		label: 'Bulleted list',
		icon: List,
		blockType: 'bulleted_list_item'
	},
	{
		id: 'numbered-list',
		group: 'insert',
		label: 'Numbered list',
		icon: ListOrdered,
		blockType: 'numbered_list_item'
	},
	{ id: 'to-do', group: 'insert', label: 'To-do', icon: ListTodo, blockType: 'to_do' },
	{ id: 'quote', group: 'insert', label: 'Quote', icon: Quote, blockType: 'quote' },
	{
		id: 'callout',
		group: 'insert',
		label: 'Callout',
		icon: MessageSquareWarning,
		blockType: 'callout'
	},
	{ id: 'toggle', group: 'insert', label: 'Toggle', icon: ListCollapse, blockType: 'toggle' },
	{ id: 'divider', group: 'insert', label: 'Divider', icon: Minus, blockType: 'divider' },
	{ id: 'code-block', group: 'insert', label: 'Code block', icon: FileCode, blockType: 'code' },
	{ id: 'table', group: 'insert', label: 'Table', icon: Table2, blockType: 'table' },
	{
		id: 'table-of-contents',
		group: 'insert',
		label: 'Table of contents',
		icon: TableOfContents,
		blockType: 'table_of_contents'
	},
	{
		id: 'synced-block',
		group: 'insert',
		label: 'Synced block',
		icon: Copy,
		blockType: 'synced_block'
	},
	{
		id: 'page-link',
		group: 'insert',
		label: 'Link to page',
		icon: Link2,
		blockType: 'page_link'
	},
	{ id: 'embed', group: 'insert', label: 'Embed', icon: PanelsTopLeft, blockType: 'embed' }
];

// The insert group's every-button-is-28px-with-a-4px-gap layout (Tailwind
// `size-7`/`gap-1`) is fixed and known ahead of time, so — unlike text —
// exactly how many fit in a given width is deterministic arithmetic, not
// something that needs a real layout engine to answer. Toolbar.svelte calls
// this with its measured container width; it's a plain function (rather than
// inlined in the component) so the overflow math has direct unit-test
// coverage without needing a real browser to measure real pixels.
export function computeVisibleInsertCount(
	total: number,
	containerWidth: number,
	buttonSize = 28,
	gap = 4
): number {
	if (total <= 0) return 0;
	// Not measured yet (e.g. before the client mounts): show everything
	// rather than guess low and have to reveal the rest a frame later.
	if (containerWidth <= 0) return total;

	const fullWidth = total * buttonSize + (total - 1) * gap;
	if (fullWidth <= containerWidth) return total;

	// containerWidth is measured on the insert group alone (bind:clientWidth
	// in Toolbar.svelte), and the overflow ("more blocks") trigger is a flex
	// *sibling* of that group, not a child of it — once the trigger renders,
	// the flex layout already shrinks the insert group's own measured width
	// to make room for it. Reserving additional space for the trigger here
	// on top of that double-counts it and hides one more control than
	// necessary.
	const fit = Math.floor((containerWidth + gap) / (buttonSize + gap));
	// At least one control stays visible, and at least one must overflow
	// (otherwise there'd be nothing for the trigger to reveal).
	return Math.max(1, Math.min(fit, total - 1));
}
