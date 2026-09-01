import { queryAuditLog, type AuditEntry, type AuditQuery } from '$lib/server/audit';

/**
 * Returns the audit history projection used by the workspace audit surface.
 * Keeping this boundary in the service layer prevents route handlers from
 * depending directly on audit persistence details.
 */
export function listAuditHistory(query: AuditQuery = {}): AuditEntry[] {
	return queryAuditLog(query);
}
