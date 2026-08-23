import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

interface DbState {
	client: Database.Database;
	db: Db;
}

// Stored on globalThis rather than a module-scoped variable — see
// ../ydoc.ts for why: this file can be loaded through more than one
// separate module graph in the same process, and each would otherwise open
// its own disconnected SQLite connection against the same file.
declare global {
	var __agentSpaceDb: DbState | undefined;
}

// Lazy + resettable (via closeDb) rather than a top-level singleton: each
// test run points DATABASE_URL at its own temp file and needs a fresh
// connection, which a module-scope `export const db = drizzle(...)` can't
// give since ESM only evaluates a module body once per process.
export function getDb(): Db {
	if (globalThis.__agentSpaceDb) return globalThis.__agentSpaceDb.db;

	const url = process.env.DATABASE_URL ?? '.data/agentspace.db';
	mkdirSync(dirname(url), { recursive: true });

	const client = new Database(url);
	client.pragma('journal_mode = WAL');
	const db = drizzle(client, { schema });
	migrate(db, { migrationsFolder: 'drizzle' });

	globalThis.__agentSpaceDb = { client, db };
	return db;
}

export function closeDb(): void {
	globalThis.__agentSpaceDb?.client.close();
	globalThis.__agentSpaceDb = undefined;
}
