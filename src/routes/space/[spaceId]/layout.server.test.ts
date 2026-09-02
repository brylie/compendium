import { describe, expect, it } from 'vitest';
import { load } from './+layout.server';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';

describe('routes/space/[spaceId]/+layout.server: Space id validation', () => {
	it('returns the spaceId as-is for a known Space', () => {
		const { defaultSpaceId } = resolveWorkspaceContext();
		const result = load({
			params: { spaceId: defaultSpaceId }
		} as unknown as Parameters<typeof load>[0]);
		expect(result).toEqual({ spaceId: defaultSpaceId });
	});

	it('redirects an unknown/foreign spaceId to the workspace default', () => {
		const { defaultSpaceId } = resolveWorkspaceContext();
		expect.assertions(1);
		try {
			// See routes/page.server.test.ts's identical case: this load is
			// synchronous and throws before ever producing a promise, despite
			// LayoutServerLoad's type allowing an async implementation.
			// eslint-disable-next-line sonarjs/void-use
			void load({
				params: { spaceId: 'not-a-real-space' }
			} as unknown as Parameters<typeof load>[0]);
		} catch (err) {
			expect(err).toMatchObject({ status: 307, location: `/space/${defaultSpaceId}` });
		}
	});
});
