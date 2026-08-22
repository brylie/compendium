import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

let client: Database.Database | null = null;
let db: Db | null = null;

// Lazy + resettable (via closeDb) rather than a top-level singleton: each
// test run points DATABASE_URL at its own temp file and needs a fresh
// connection, which a module-scope `export const db = drizzle(...)` can't
// give since ESM only evaluates a module body once per process.
export function getDb(): Db {
	if (db) return db;

	const url = process.env.DATABASE_URL ?? '.data/agentspace.db';
	mkdirSync(dirname(url), { recursive: true });

	client = new Database(url);
	client.pragma('journal_mode = WAL');
	db = drizzle(client, { schema });
	migrate(db, { migrationsFolder: 'drizzle' });

	return db;
}

export function closeDb(): void {
	client?.close();
	client = null;
	db = null;
}
