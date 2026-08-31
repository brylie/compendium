import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import type { PageServerLoad } from './$types';

// The workspace root has no content of its own — it always sends the caller
// into a Space (#6 Phase A). No "last active Space" persistence (cookie or
// similar) yet; always the workspace's bootstrap default.
export const load: PageServerLoad = () => {
	const { defaultSpaceId } = resolveWorkspaceContext();
	redirect(307, resolve('/space/[spaceId]', { spaceId: defaultSpaceId }));
};
