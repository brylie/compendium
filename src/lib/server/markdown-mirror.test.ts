import { describe, it, expect, afterEach } from 'vitest';
import { wireMarkdownMirrorOnce, stopMarkdownMirrorSchedule } from './markdown-mirror';

describe('markdown-mirror scheduler', () => {
	afterEach(() => {
		stopMarkdownMirrorSchedule();
	});

	it('wires the schedule idempotently', () => {
		expect(() => {
			wireMarkdownMirrorOnce();
			wireMarkdownMirrorOnce();
		}).not.toThrow();
	});
});
