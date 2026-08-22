import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SNAPSHOT_RETENTION = 5;

let db: Database.Database | null = null;

export function getDb(): Database.Database {
	if (db) return db;
	const dbPath = process.env.AGENTSPACE_DB_PATH ?? '.data/agentspace.db';
	mkdirSync(dirname(dbPath), { recursive: true });
	db = new Database(dbPath);
	db.pragma('journal_mode = WAL');
	db.exec(`
		CREATE TABLE IF NOT EXISTS snapshots (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			state BLOB NOT NULL,
			created_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS audit_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			actor_json TEXT NOT NULL,
			action TEXT NOT NULL,
			target_record_id TEXT,
			timestamp INTEGER NOT NULL,
			diff_json TEXT
		);
		CREATE TABLE IF NOT EXISTS access_tokens (
			token_hash TEXT PRIMARY KEY,
			client_label TEXT NOT NULL,
			allowed_document_ids TEXT NOT NULL,
			allowed_collection_ids TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			revoked_at INTEGER
		);
	`);
	return db;
}

export function closeDb(): void {
	db?.close();
	db = null;
}

export interface SnapshotStore {
	loadLatest(): Uint8Array | null;
	save(state: Uint8Array): void;
}

export function getSnapshotStore(): SnapshotStore {
	const database = getDb();
	return {
		loadLatest(): Uint8Array | null {
			const row = database.prepare('SELECT state FROM snapshots ORDER BY id DESC LIMIT 1').get() as
				{ state: Buffer } | undefined;
			return row ? new Uint8Array(row.state) : null;
		},
		save(state: Uint8Array): void {
			database
				.prepare('INSERT INTO snapshots (state, created_at) VALUES (?, ?)')
				.run(Buffer.from(state), Date.now());
			database
				.prepare(
					`DELETE FROM snapshots WHERE id NOT IN (
						SELECT id FROM snapshots ORDER BY id DESC LIMIT ?
					)`
				)
				.run(SNAPSHOT_RETENTION);
		}
	};
}
