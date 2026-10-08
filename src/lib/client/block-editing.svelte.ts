import { tick } from 'svelte';
import type * as Y from 'yjs';
import { CURRENT_USER } from '$lib/client/actor';
import { LOCAL_UI_ORIGIN, transactWithOrigin } from '$lib/mutation-origin';
import {
	createRecord,
	deleteRecord,
	getRecord,
	getRecordYText,
	parentKindOf,
	setBlockType
} from '$lib/data/record-ops';
import {
	appendRichTextToYText,
	applyRichTextToYText,
	plainText,
	splitRichTextAt,
	yTextToRichText
} from '$lib/data/richtext';
import { BLOCK_CAPABILITIES, blockCapabilitiesFor } from '$lib/data/block-capabilities';
import type { BlockType, WorkspaceRecord } from '$lib/data/types';
import type { BlockEditorHandle } from '$lib/components/BlockRow.svelte';

export const LIST_BLOCK_TYPES: readonly BlockType[] = [
	'bulleted_list_item',
	'numbered_list_item',
	'to_do'
];

/**
 * Every Document-kind record gets a `content` Y.Text at creation
 * regardless of blockType (see createRecord), so its mere presence can't
 * distinguish a block that holds free-form inline text from one that
 * doesn't — these block types have a structurally different content
 * shape (a table's rows, a divider's absence of content, a reference to
 * another record) where "append/merge plain text into it" isn't a
 * meaningful operation. Used to gate both Backspace-joins-the-previous-
 * block and the toolbar's convert-current-block-in-place behavior.
 * Driven by BLOCK_CAPABILITIES (issue #229) instead of its own list.
 */
export function blockHoldsFreeformText(blockType?: BlockType): boolean {
	return !!blockType && blockCapabilitiesFor(blockType).holdsFreeformText;
}

export interface BlockEditingOptions {
	getYdoc: () => Y.Doc | undefined;
	getDefaultParentId: () => string;
	getBlocks: () => readonly WorkspaceRecord[];
	getBlockEditor: (blockId: string) => BlockEditorHandle | undefined;
	createRecord?: typeof createRecord;
	applyRichTextToYText?: typeof applyRichTextToYText;
}

/**
 * Owns block editing and keyboard handling (issue #241/#298):
 * Enter splits or list continuations, Backspace joins with preceding block,
 * vertical arrow navigation across blocks, and toolbar insert targeting.
 */
export function createBlockEditing(options: BlockEditingOptions) {
	const {
		getYdoc,
		getDefaultParentId,
		getBlocks,
		getBlockEditor,
		createRecord: createRecordFn = createRecord,
		applyRichTextToYText: applyRichTextToYTextFn = applyRichTextToYText
	} = options;

	function isBlockTextEmpty(blockId: string): boolean {
		const ydoc = getYdoc();
		if (!ydoc) return true;
		const ytext = getRecordYText(ydoc, blockId);
		return !ytext || plainText(yTextToRichText(ytext)).length === 0;
	}

	async function addBlockAfter(
		afterId?: string,
		blockType: BlockType = 'paragraph',
		parentId = getDefaultParentId()
	): Promise<WorkspaceRecord | undefined> {
		const ydoc = getYdoc();
		if (!ydoc) return undefined;
		const record = transactWithOrigin(ydoc, LOCAL_UI_ORIGIN, () =>
			createRecordFn(ydoc, { parentId, blockType, afterRecordId: afterId }, CURRENT_USER)
		);
		await tick();
		getBlockEditor(record.id)?.focusEditor(true);
		return record;
	}

	function resolveToolbarInsertTarget(
		afterId: string | undefined,
		blockType: BlockType
	): { parentId: string; afterId: string | undefined } {
		const defaultParentId = getDefaultParentId();
		const fallback = { parentId: defaultParentId, afterId };
		const ydoc = getYdoc();
		if (!ydoc || !afterId) return fallback;
		const active = getRecord(ydoc, afterId);
		if (!active) return fallback;
		if (parentKindOf(ydoc, active.parentId) !== 'record') {
			return { parentId: active.parentId, afterId };
		}
		const allowedInColumn = BLOCK_CAPABILITIES.column.childBlockTypes;
		if (allowedInColumn?.includes(blockType)) return { parentId: active.parentId, afterId };
		const column = getRecord(ydoc, active.parentId);
		const columnsBlock = column ? getRecord(ydoc, column.parentId) : undefined;
		return { parentId: defaultParentId, afterId: columnsBlock?.id ?? afterId };
	}

	async function splitBlockOnEnter(
		block: WorkspaceRecord,
		caretOffset: number,
		nextBlockType: BlockType
	): Promise<void> {
		const ydoc = getYdoc();
		if (!ydoc) return;
		const currentDoc = ydoc;
		const ytext = getRecordYText(ydoc, block.id);
		const richText = ytext ? yTextToRichText(ytext) : { runs: [] };
		const offset = ytext ? Math.min(Math.max(0, caretOffset), ytext.length) : 0;
		const { after } = splitRichTextAt(richText, offset);

		if (ytext && offset < ytext.length) {
			const doc = ytext.doc;
			const trim = () => ytext.delete(offset, ytext.length - offset);
			if (doc) doc.transact(trim, LOCAL_UI_ORIGIN);
			else trim();
		}

		const record = transactWithOrigin(ydoc, LOCAL_UI_ORIGIN, () =>
			createRecordFn(
				currentDoc,
				{ parentId: getDefaultParentId(), blockType: nextBlockType, afterRecordId: block.id },
				CURRENT_USER
			)
		);
		if (after.runs.length > 0) {
			const newYtext = getRecordYText(ydoc, record.id);
			if (newYtext) {
				transactWithOrigin(currentDoc, LOCAL_UI_ORIGIN, () =>
					applyRichTextToYTextFn(newYtext, after)
				);
			}
		}
		await tick();
		if (offset === 0) {
			getBlockEditor(block.id)?.focusEditor(true);
		} else {
			getBlockEditor(record.id)?.focusEditor(true);
		}
	}

	async function handleEnter(block: WorkspaceRecord, caretOffset: number): Promise<void> {
		const blockType = block.blockType ?? 'paragraph';
		const isList = LIST_BLOCK_TYPES.includes(blockType);
		if (isList && isBlockTextEmpty(block.id)) {
			const ydoc = getYdoc();
			if (!ydoc) return;
			setBlockType(ydoc, block.id, 'paragraph', CURRENT_USER);
			await tick();
			getBlockEditor(block.id)?.focusEditor(true);
			return;
		}
		await splitBlockOnEnter(block, caretOffset, isList ? blockType : 'paragraph');
	}

	async function handleBackspace(block: WorkspaceRecord, index: number): Promise<void> {
		const ydoc = getYdoc();
		if (!ydoc) return;
		const currentDoc = ydoc;
		const blocks = getBlocks();
		const previous = blocks[index - 1];
		if (!previous) return;
		if ((block.childRecordIds?.length ?? 0) > 0) return;

		const currentYtext = getRecordYText(currentDoc, block.id);
		const currentIsEmpty = !currentYtext || currentYtext.length === 0;
		const previousHoldsText = blockHoldsFreeformText(previous.blockType);
		if (!currentIsEmpty && !previousHoldsText) return;

		const previousYtext = previousHoldsText ? getRecordYText(currentDoc, previous.id) : undefined;
		const joinOffset = previousYtext?.length ?? 0;
		transactWithOrigin(currentDoc, LOCAL_UI_ORIGIN, () => {
			if (!currentIsEmpty && previousYtext && currentYtext) {
				appendRichTextToYText(previousYtext, yTextToRichText(currentYtext));
			}
			deleteRecord(currentDoc, block.id);
		});
		await tick();
		getBlockEditor(previous.id)?.focusEditor(joinOffset);
	}

	function handleArrowUpAtStart(index: number, clientX: number | null): boolean {
		const blocks = getBlocks();
		for (let i = index - 1; i >= 0; i--) {
			const editor = getBlockEditor(blocks[i].id);
			if (editor) {
				editor.focusEditorAtLine('last', clientX);
				return true;
			}
		}
		return false;
	}

	function handleArrowDownAtEnd(index: number, clientX: number | null): boolean {
		const blocks = getBlocks();
		for (let i = index + 1; i < blocks.length; i++) {
			const editor = getBlockEditor(blocks[i].id);
			if (editor) {
				editor.focusEditorAtLine('first', clientX);
				return true;
			}
		}
		return false;
	}

	return {
		isBlockTextEmpty,
		addBlockAfter,
		resolveToolbarInsertTarget,
		splitBlockOnEnter,
		handleEnter,
		handleBackspace,
		handleArrowUpAtStart,
		handleArrowDownAtEnd
	};
}
