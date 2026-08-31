import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRequestContext } from './request-context';
import { createSpace } from './catalog';
import { resolveWorkspaceContext } from './workspace-store';
import { CURRENT_USER } from './current-user';

describe('request-context: resolveRequestContext (#111/#138)', () => {
	const originalInstanceId = process.env.COMPENDIUM_INSTANCE_ID;

	beforeEach(() => {
		delete process.env.COMPENDIUM_INSTANCE_ID;
	});

	afterEach(() => {
		delete process.env.COMPENDIUM_INSTANCE_ID;
	});

	afterAll(() => {
		if (originalInstanceId !== undefined) {
			process.env.COMPENDIUM_INSTANCE_ID = originalInstanceId;
		}
	});

	it('defaults caller to CURRENT_USER and resolves workspaceId from instance config', () => {
		const context = resolveRequestContext();
		expect(context.caller).toEqual(CURRENT_USER);
		expect(context.workspaceId).toBe('default');
		expect(context.instanceId).toBe('default');
	});

	it('accepts an explicit caller', () => {
		const token = { tokenHash: 'x', clientLabel: 'test', createdAt: Date.now() } as never;
		const context = resolveRequestContext(token);
		expect(context.caller).toBe(token);
	});

	it('resolves workspaceId from COMPENDIUM_INSTANCE_ID when set', () => {
		process.env.COMPENDIUM_INSTANCE_ID = 'instance-a';
		const context = resolveRequestContext();
		expect(context.workspaceId).toBe('instance-a');
		expect(context.instanceId).toBe('instance-a');
	});

	it('allowedSpaceIds includes every Space in the resolved workspace', () => {
		const { workspaceId } = resolveWorkspaceContext();
		const extraSpace = createSpace(workspaceId, 'Extra Space');

		const context = resolveRequestContext();
		expect(context.allowedSpaceIds.has(extraSpace.id)).toBe(true);
		expect(context.allowedSpaceIds.size).toBeGreaterThanOrEqual(2); // default + extra
	});

	it('bootstraps the catalog even when nothing has resolved this workspace yet', () => {
		process.env.COMPENDIUM_INSTANCE_ID = 'fresh-instance';
		const context = resolveRequestContext();
		// A default Space must already exist — resolveRequestContext() itself
		// triggers bootstrap rather than assuming some earlier call already did.
		expect(context.allowedSpaceIds.size).toBeGreaterThanOrEqual(1);
	});
});
