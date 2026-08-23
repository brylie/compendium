import { describe, expect, it } from 'vitest';
import { diffPlainText } from './text-diff';

describe('diffPlainText', () => {
	it('finds an insertion in the middle of unchanged text', () => {
		expect(diffPlainText('hello world', 'hello brave world')).toEqual({
			start: 6,
			deleteCount: 0,
			insertText: 'brave '
		});
	});

	it('finds a deletion', () => {
		expect(diffPlainText('hello brave world', 'hello world')).toEqual({
			start: 6,
			deleteCount: 6,
			insertText: ''
		});
	});

	it('finds a replacement in the middle', () => {
		expect(diffPlainText('hello world', 'hello there')).toEqual({
			start: 6,
			deleteCount: 5,
			insertText: 'there'
		});
	});

	it('returns a no-op diff for identical text', () => {
		expect(diffPlainText('same', 'same')).toEqual({ start: 4, deleteCount: 0, insertText: '' });
	});

	it('handles a fully replaced string with no shared prefix or suffix', () => {
		expect(diffPlainText('abc', 'xyz')).toEqual({ start: 0, deleteCount: 3, insertText: 'xyz' });
	});

	it('handles growing from empty text', () => {
		expect(diffPlainText('', 'new')).toEqual({ start: 0, deleteCount: 0, insertText: 'new' });
	});

	it('handles shrinking to empty text', () => {
		expect(diffPlainText('gone', '')).toEqual({ start: 0, deleteCount: 4, insertText: '' });
	});
});
