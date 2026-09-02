import { describe, expect, it } from 'vitest';
import { load } from './+page.server';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';

describe('routes/+page.server: workspace root', () => {
	it('redirects to the workspace default Space', () => {
		const { defaultSpaceId } = resolveWorkspaceContext();
		expect.assertions(1);
		try {
			// PageServerLoad's type allows an async implementation, but this
			// one is synchronous and throws (redirect()) before ever
			// returning a promise — `void` acknowledges the call's type
			// without pretending we need to await a promise that, in this
			// implementation, is never actually produced before the throw.
			// (sonarjs/void-use and no-floating-promises want opposite things
			// here; the latter is the one actually protecting against a real
			// mistake, so it wins.)
			// eslint-disable-next-line sonarjs/void-use
			void load(undefined as unknown as Parameters<typeof load>[0]);
		} catch (err) {
			expect(err).toMatchObject({ status: 307, location: `/space/${defaultSpaceId}` });
		}
	});
});
