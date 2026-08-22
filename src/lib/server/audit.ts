import { and, desc, gte, lte } from 'drizzle-orm';
import { getDb } from './store.js';
import { auditLog } from './db/schema.js';
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
	since?: number;
	until?: number;
	limit?: number;
}

export function queryAuditLog(query: AuditQuery = {}): AuditEntry[] {
	const rows = getDb()
		.select()
		.from(auditLog)
		.where(
			and(
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
