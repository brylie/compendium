import { describe, expect, it } from 'vitest';
import { load } from './+page.server';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';

describe('routes/+page.server: workspace root', () => {
	it('redirects to the workspace default Space', () => {
		const { defaultSpaceId } = resolveWorkspaceContext();
		expect.assertions(1);
		try {
			load(undefined as unknown as Parameters<typeof load>[0]);
		} catch (err) {
			expect(err).toMatchObject({ status: 307, location: `/space/${defaultSpaceId}` });
		}
	});
});
