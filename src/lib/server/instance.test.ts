import { afterEach, describe, expect, it } from 'vitest';
import { getInstanceWorkspaceId } from './instance';

describe('instance: getInstanceWorkspaceId (#111)', () => {
	afterEach(() => {
		delete process.env.COMPENDIUM_INSTANCE_ID;
	});

	it("falls back to 'default' when COMPENDIUM_INSTANCE_ID is unset", () => {
		delete process.env.COMPENDIUM_INSTANCE_ID;
		expect(getInstanceWorkspaceId()).toBe('default');
	});

	it('respects COMPENDIUM_INSTANCE_ID when set', () => {
		process.env.COMPENDIUM_INSTANCE_ID = 'dev-instance';
		expect(getInstanceWorkspaceId()).toBe('dev-instance');
	});

	it('reads the env var fresh on every call, not cached', () => {
		process.env.COMPENDIUM_INSTANCE_ID = 'first';
		expect(getInstanceWorkspaceId()).toBe('first');
		process.env.COMPENDIUM_INSTANCE_ID = 'second';
		expect(getInstanceWorkspaceId()).toBe('second');
	});
});
