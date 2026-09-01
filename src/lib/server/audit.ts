import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { getDb } from './store.js';
import { auditLog, recordLocator } from './db/schema.js';
import type { ActorId } from '$lib/data/types';

export interface AuditEntry {
	id: number;
	actor: ActorId;
	action: string;
	targetRecordId?: string;
	timestamp: number;
	diff?: unknown;
}

export function logAudit(input: {
	actor: ActorId;
	action: string;
	targetRecordId?: string;
	diff?: unknown;
}): void {
	getDb()
		.insert(auditLog)
		.values({
			actor: input.actor,
			action: input.action,
			targetRecordId: input.targetRecordId ?? null,
			timestamp: Date.now(),
			diff: input.diff !== undefined ? input.diff : null
		})
		.run();
}

export interface AuditQuery {
	actorFilter?: (actor: ActorId) => boolean;
	targetRecordId?: string;
	since?: number;
	until?: number;
	limit?: number;
}

/** Returns newest-first audit entries matching the supplied projection filters. */
export function queryAuditLog(query: AuditQuery = {}): AuditEntry[] {
	const rows = getDb()
		.select()
		.from(auditLog)
		.where(
			and(
				query.targetRecordId !== undefined
					? eq(auditLog.targetRecordId, query.targetRecordId)
					: undefined,
				gte(auditLog.timestamp, query.since ?? 0),
				lte(auditLog.timestamp, query.until ?? Number.MAX_SAFE_INTEGER)
			)
		)
		.orderBy(desc(auditLog.id))
		.limit(query.limit ?? 500)
		.all();

	return rows
		.map((row) => ({
			id: row.id,
			actor: row.actor,
			action: row.action,
			targetRecordId: row.targetRecordId ?? undefined,
			timestamp: row.timestamp,
			diff: row.diff ?? undefined
		}))
		.filter((entry) => (query.actorFilter ? query.actorFilter(entry.actor) : true));
}

/**
 * Audit entries whose target record is tracked in the given Space — a join
 * through record_locator, not a stored column on audit_log itself (that
 * table has no workspaceId/spaceId of its own, see db/schema.ts): a record's
 * Space membership can change (a future move-between-spaces operation), and
 * a stored copy on every historical audit row would drift from that. An
 * entry with no targetRecordId (e.g. search_workspace's own audit entry) or
 * whose target was never locator-tracked (uncataloged content) is excluded —
 * it has no known Space to attribute it to, and #133's isolation bar is
 * "never surfaces a Space's audit history to a caller scoped to another,"
 * not "guess at unknown attribution."
 */
export function queryAuditLogForSpace(
	workspaceId: string,
	spaceId: string,
	query: AuditQuery = {}
): AuditEntry[] {
	const rows = getDb()
		.select({
			id: auditLog.id,
			actor: auditLog.actor,
			action: auditLog.action,
			targetRecordId: auditLog.targetRecordId,
			timestamp: auditLog.timestamp,
			diff: auditLog.diff
		})
		.from(auditLog)
		.innerJoin(
			recordLocator,
			and(
				eq(recordLocator.workspaceId, workspaceId),
				eq(recordLocator.recordId, auditLog.targetRecordId)
			)
		)
		.where(
			and(
				eq(recordLocator.spaceId, spaceId),
				query.targetRecordId !== undefined
					? eq(auditLog.targetRecordId, query.targetRecordId)
					: undefined,
				gte(auditLog.timestamp, query.since ?? 0),
				lte(auditLog.timestamp, query.until ?? Number.MAX_SAFE_INTEGER)
			)
		)
		.orderBy(desc(auditLog.id))
		.limit(query.limit ?? 500)
		.all();

	return rows
		.map((row) => ({
			id: row.id,
			actor: row.actor,
			action: row.action,
			targetRecordId: row.targetRecordId ?? undefined,
			timestamp: row.timestamp,
			diff: row.diff ?? undefined
		}))
		.filter((entry) => (query.actorFilter ? query.actorFilter(entry.actor) : true));
}
