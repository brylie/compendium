import { getDb } from './store.js';
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
		.prepare(
			`INSERT INTO audit_log (actor_json, action, target_record_id, timestamp, diff_json)
			 VALUES (?, ?, ?, ?, ?)`
		)
		.run(
			JSON.stringify(input.actor),
			input.action,
			input.targetRecordId ?? null,
			Date.now(),
			input.diff !== undefined ? JSON.stringify(input.diff) : null
		);
}

export interface AuditQuery {
	actorFilter?: (actor: ActorId) => boolean;
	since?: number;
	until?: number;
	limit?: number;
}

interface AuditRow {
	id: number;
	actor_json: string;
	action: string;
	target_record_id: string | null;
	timestamp: number;
	diff_json: string | null;
}

export function queryAuditLog(query: AuditQuery = {}): AuditEntry[] {
	const rows = getDb()
		.prepare(
			`SELECT id, actor_json, action, target_record_id, timestamp, diff_json
			 FROM audit_log
			 WHERE timestamp >= ? AND timestamp <= ?
			 ORDER BY id DESC
			 LIMIT ?`
		)
		.all(
			query.since ?? 0,
			query.until ?? Number.MAX_SAFE_INTEGER,
			query.limit ?? 500
		) as AuditRow[];

	return rows
		.map((row) => ({
			id: row.id,
			actor: JSON.parse(row.actor_json) as ActorId,
			action: row.action,
			targetRecordId: row.target_record_id ?? undefined,
			timestamp: row.timestamp,
			diff: row.diff_json ? JSON.parse(row.diff_json) : undefined
		}))
		.filter((entry) => (query.actorFilter ? query.actorFilter(entry.actor) : true));
}
