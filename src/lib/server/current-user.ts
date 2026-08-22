import type { ActorId } from '$lib/data/types';

/**
 * Default single-tenant human actor for the local workspace.
 * When multi-user auth lands, this will be replaced by session-extracted identity.
 */
export const CURRENT_USER: ActorId = { kind: 'human', userId: 'local' };
