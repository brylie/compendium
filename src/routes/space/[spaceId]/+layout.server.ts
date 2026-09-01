import { redirect } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { isKnownSpace } from '$lib/server/catalog';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import type { LayoutServerLoad } from './$types';

// Validates the URL's [spaceId] segment before any nested route trusts it.
// A foreign/invalid id redirects to the workspace's default Space rather
// than 404ing — no real membership/permission model exists yet to make a
// hard failure meaningful (same "degrade gracefully" posture as #111/#138's
// shard-hardening).
export const load: LayoutServerLoad = ({ params }) => {
	const { workspaceId, defaultSpaceId } = resolveWorkspaceContext();
	if (!isKnownSpace(workspaceId, params.spaceId)) {
		redirect(307, resolve('/space/[spaceId]', { spaceId: defaultSpaceId }));
	}
	return { spaceId: params.spaceId };
};
