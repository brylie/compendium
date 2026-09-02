// caret.ts's setCaretNearClientX deliberately uses the deprecated, non-
// standard `document.caretRangeFromPoint` as its primary point-based
// hit-testing strategy (with the standards-track `caretPositionFromPoint`
// as a fallback for browsers that lack it) — this suite exists specifically
// to test that feature-detection/fallback behavior, so mocking the
// deprecated API is the point, not something to work around.
/* eslint-disable sonarjs/deprecation */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

	it('does not treat a non-collapsed (active) selection as being at either edge', () => {
		// A ranged selection must keep the browser's native ArrowUp/ArrowDown
		// behavior (collapse to one end) — treating it as "at the edge" would
		// have callers jump focus to another block mid-selection.
		selectRange(root, 2, 7);
		expect(isCaretAtFirstLine(root)).toBe(false);
		expect(isCaretAtLastLine(root)).toBe(false);
	});
});

describe('caret: point-based hit-testing (mocked, since jsdom implements neither API)', () => {
	let root: HTMLElement;
	const originalGetClientRects = Range.prototype.getClientRects;

	beforeEach(() => {
		root = document.createElement('div');
		root.tabIndex = 0;
		root.textContent = 'hello world';
		document.body.appendChild(root);
		window.getSelection()?.removeAllRanges();
		// Gives every Range a real (non-zero) rect, so getEdgeLineY can
		// resolve an actual target line instead of bailing out early.
		Range.prototype.getClientRects = function (this: Range) {
			return [
				{ top: 10, bottom: 20, height: 10, left: 0, width: 5, right: 5, x: 0, y: 10 }
			] as unknown as DOMRectList;
		};
	});

	afterEach(() => {
		Range.prototype.getClientRects = originalGetClientRects;
		delete (document as { caretRangeFromPoint?: unknown }).caretRangeFromPoint;
		delete (document as { caretPositionFromPoint?: unknown }).caretPositionFromPoint;
	});

	it('uses caretRangeFromPoint to land the caret at the hit-tested offset', () => {
		const textNode = root.firstChild as Text;
		document.caretRangeFromPoint = ((): Range => {
			const r = document.createRange();
			r.setStart(textNode, 3);
			r.collapse(true);
			return r;
		}) as typeof document.caretRangeFromPoint;

		setCaretNearClientX(root, 50, 'first');
		expect(getCaretOffset(root)).toBe(3);
	});

	it('falls back to caretPositionFromPoint when caretRangeFromPoint is unavailable', () => {
		const textNode = root.firstChild as Text;
		document.caretPositionFromPoint = ((): unknown => ({
			offsetNode: textNode,
			offset: 4
		})) as typeof document.caretPositionFromPoint;

		setCaretNearClientX(root, 50, 'last');
		expect(getCaretOffset(root)).toBe(4);
	});

	it('falls back to the block start/end when the hit-tested point lands outside root', () => {
		const other = document.createElement('div');
		other.textContent = 'elsewhere';
		document.body.appendChild(other);
		const otherText = other.firstChild as Text;
		document.caretRangeFromPoint = ((): Range => {
			const r = document.createRange();
			r.setStart(otherText, 2);
			r.collapse(true);
			return r;
		}) as typeof document.caretRangeFromPoint;

		setCaretNearClientX(root, 50, 'first');
		expect(getCaretOffset(root)).toBe(0);
	});

	it('falls back to the block start/end without attempting point-based hit-testing on an empty block', () => {
		root.textContent = '';
		document.caretRangeFromPoint = (() => {
			throw new Error(
				'should not be called when there is no edge-line geometry to hit-test against'
			);
		}) as unknown as typeof document.caretRangeFromPoint;

		expect(() => setCaretNearClientX(root, 50, 'first')).not.toThrow();
		expect(getCaretOffset(root)).toBe(0);
	});
});
