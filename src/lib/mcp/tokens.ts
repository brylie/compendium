/**
 * Compatibility exports for MCP transport callers. Token persistence belongs
 * to the neutral server store so application services do not depend on MCP.
 */
export {
	createToken,
	grantCollectionAccess,
	grantDocumentAccess,
	hashToken,
	listTokens,
	revokeToken,
	tokenAllowsParent,
	verifyToken,
	type AccessToken
} from '$lib/server/token-store';
