import { describe, it, expect, afterEach, vi } from 'vitest';
import { wireMarkdownMirrorOnce, stopMarkdownMirrorSchedule } from './markdown-mirror';

describe('markdown-mirror scheduler', () => {
	afterEach(() => {
		stopMarkdownMirrorSchedule();
		vi.useRealTimers();
	});

	it('wires the schedule idempotently', () => {
		vi.useFakeTimers();
		const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

		expect(() => {
			wireMarkdownMirrorOnce();
			wireMarkdownMirrorOnce();
		}).not.toThrow();

		expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
	});
});
