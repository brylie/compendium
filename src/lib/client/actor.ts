import type { ActorId } from '$lib/data/types';

// Phase 0 is single-tenant, local-trust: one fixed human identity for
// whoever is sitting at this browser. Multi-user identity is Phase 1 (PRD
// Non-Goals #7).
export const CURRENT_USER: ActorId = { kind: 'human', userId: 'local' };
