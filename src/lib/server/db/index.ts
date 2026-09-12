import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

// `record_index` (persistence.md §2) is a SQLite FTS5 virtual table, not a
// plain rowid table — drizzle-kit's schema.ts/migration generator has no
// representation for a virtual table, so it's created here directly with
// raw DDL instead of going through schema.ts + `npm run db:generate`.
// Idempotent (`IF NOT EXISTS`) so it's safe to run on every `getDb()` call
// across restarts and test runs. `record_id` is deliberately UNINDEXED with
// no uniqueness constraint of its own — FTS5 has no such constraint — see
// record-index.ts's upsert, which does its own delete-then-insert.
const CREATE_RECORD_INDEX_TABLE = `
	CREATE VIRTUAL TABLE IF NOT EXISTS record_index USING fts5(
		record_id UNINDEXED,
		workspace_id UNINDEXED,
		shard_id UNINDEXED,
		parent_id UNINDEXED,
		parent_type UNINDEXED,
		plain_text_content,
		properties_json UNINDEXED
	)
`;

interface DbState {
	client: Database.Database;
	db: Db;
}

// Stored on globalThis rather than a module-scoped variable — see
// ../ydoc.ts for why: this file can be loaded through more than one
// separate module graph in the same process, and each would otherwise open
// its own disconnected SQLite connection against the same file.
declare global {
	var __db: DbState | undefined;
}

/**
 * Lazy + resettable (via closeDb) rather than a top-level singleton: each
 * test run points DATABASE_URL at its own temp file and needs a fresh
 * connection, which a module-scope `export const db = drizzle(...)` can't
 * give since ESM only evaluates a module body once per process.
 */
export function getDb(): Db {
	if (globalThis.__db) return globalThis.__db.db;

	const url = process.env.DATABASE_URL ?? '.data/compendium.db';
	// DATABASE_URL is deploy-time server configuration (mise's [env] .file, or
	// the process environment) — never derived from a request, so this isn't
	// path traversal risk the way a request-supplied filename would be.
	// eslint-disable-next-line security/detect-non-literal-fs-filename
	mkdirSync(dirname(url), { recursive: true });

	const client = new Database(url);
	client.pragma('journal_mode = WAL');
	// better-sqlite3 doesn't enforce foreign keys unless this is set per
	// connection — without it, the catalog's spaceId foreign keys (see
	// db/schema.ts) would silently allow an orphaned Space reference instead
	// of rejecting it.
	client.pragma('foreign_keys = ON');
	const db = drizzle(client, { schema });
	migrate(db, { migrationsFolder: 'drizzle' });
	client.exec(CREATE_RECORD_INDEX_TABLE);

	globalThis.__db = { client, db };
	return db;
}

/** Closes the process's shared SQLite connection and clears it so the next `getDb()` call opens a fresh one. */
export function closeDb(): void {
	globalThis.__db?.client.close();
	globalThis.__db = undefined;
}
