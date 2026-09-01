import { beforeEach, describe, expect, it } from 'vitest';
import {
	getCaretClientX,
	getCaretOffset,
	getSelectionOffsets,
	isCaretAtFirstLine,
	isCaretAtLastLine,
	setCaretNearClientX,
	setCaretOffset
} from './caret';

function selectRange(root: HTMLElement, start: number, end: number): void {
	const textNode = root.firstChild as Text;
	const range = document.createRange();
	range.setStart(textNode, start);
	range.setEnd(textNode, end);
	const selection = window.getSelection()!;
	selection.removeAllRanges();
	selection.addRange(range);
}

describe('caret: offset <-> DOM selection conversion', () => {
	let root: HTMLElement;

	beforeEach(() => {
		root = document.createElement('div');
		root.textContent = 'hello world';
		document.body.appendChild(root);
		window.getSelection()?.removeAllRanges();
	});

	it('returns 0 when there is no active selection', () => {
		expect(getCaretOffset(root)).toBe(0);
		expect(getSelectionOffsets(root)).toBeNull();
	});

	it('returns 0 when the selection lies outside root', () => {
		const other = document.createElement('div');
		other.textContent = 'elsewhere';
		document.body.appendChild(other);
		selectRange(other, 1, 1);
		expect(getCaretOffset(root)).toBe(0);
		expect(getSelectionOffsets(root)).toBeNull();
	});

	it('reports the collapsed caret offset within root', () => {
		selectRange(root, 5, 5);
		expect(getCaretOffset(root)).toBe(5);
	});

	it('reports a non-collapsed selection as start/end offsets', () => {
		selectRange(root, 2, 7);
		expect(getSelectionOffsets(root)).toEqual({ start: 2, end: 7 });
	});

	it('returns null when only the selection end lies outside root', () => {
		const other = document.createElement('div');
		other.textContent = 'x';
		document.body.appendChild(other);
		const range = document.createRange();
		range.setStart(root.firstChild as Text, 0);
		range.setEnd(other.firstChild as Text, 1);
		const selection = window.getSelection()!;
		selection.removeAllRanges();
		selection.addRange(range);
		expect(getSelectionOffsets(root)).toBeNull();
	});

	it('places the caret at a given character offset', () => {
		setCaretOffset(root, 3);
		expect(getCaretOffset(root)).toBe(3);
	});

	it('collapses to the end of root when the offset exceeds its text length', () => {
		setCaretOffset(root, 999);
		expect(getCaretOffset(root)).toBe('hello world'.length);
	});

	it('no-ops when there is no selection object available', () => {
		const originalGetSelection = window.getSelection;
		window.getSelection = () => null;
		expect(() => setCaretOffset(root, 2)).not.toThrow();
		window.getSelection = originalGetSelection;
	});
});

describe('caret: cross-block ArrowUp/ArrowDown geometry', () => {
	let root: HTMLElement;

	beforeEach(() => {
		root = document.createElement('div');
		root.tabIndex = 0;
		root.textContent = 'hello world';
		document.body.appendChild(root);
		window.getSelection()?.removeAllRanges();
	});

	// jsdom performs no real layout, so every rect is zero-sized — the same
	// "can't tell where the line boundaries are" case a real browser hits for
	// an empty/unrendered element. Both helpers treat that as "at the edge" /
	// "no usable x", which is also the correct behavior a caller wants for a
	// single-line block (headings, list items) where there's only one line.

	it('treats a caret with no resolvable geometry as being at both edges', () => {
		selectRange(root, 5, 5);
		expect(isCaretAtFirstLine(root)).toBe(true);
		expect(isCaretAtLastLine(root)).toBe(true);
	});

	it('reports at-edge with no selection at all', () => {
		expect(isCaretAtFirstLine(root)).toBe(true);
		expect(isCaretAtLastLine(root)).toBe(true);
	});

	it('returns null client-x when there is no resolvable geometry', () => {
		selectRange(root, 5, 5);
		expect(getCaretClientX(root)).toBeNull();
	});

	it('returns null client-x when the selection lies outside root', () => {
		expect(getCaretClientX(root)).toBeNull();
	});

	it('falls back to the block start when landing on the first line without point-based hit-testing', () => {
		setCaretNearClientX(root, 42, 'first');
		expect(getCaretOffset(root)).toBe(0);
		expect(document.activeElement).toBe(root);
	});

	it('falls back to the block end when landing on the last line without point-based hit-testing', () => {
		setCaretNearClientX(root, 42, 'last');
		expect(getCaretOffset(root)).toBe('hello world'.length);
	});

	it('falls back to the block start/end when clientX is null', () => {
		setCaretNearClientX(root, null, 'first');
		expect(getCaretOffset(root)).toBe(0);
		setCaretNearClientX(root, null, 'last');
		expect(getCaretOffset(root)).toBe('hello world'.length);
	});
});
