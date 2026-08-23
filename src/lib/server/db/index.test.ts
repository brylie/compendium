import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { closeDb, getDb } from './index';

describe('db: default DATABASE_URL fallback', () => {
	let dir: string;
	let originalCwd: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		dir = mkdtempSync(join(tmpdir(), 'db-default-'));
		// getDb() resolves both the default sqlite path and drizzle's migrations
		// folder relative to process.cwd() — symlink the real migrations folder
		// in so migrate() succeeds without ever touching the real repo's own
		// .data/compendium.db (the actual dev workspace database).
		symlinkSync(resolve(originalCwd, 'drizzle'), join(dir, 'drizzle'), 'dir');
		process.chdir(dir);
		delete process.env.DATABASE_URL;
	});

	afterEach(() => {
		closeDb();
		process.chdir(originalCwd);
		rmSync(dir, { recursive: true, force: true });
	});

	it('falls back to .data/compendium.db under the current working directory when DATABASE_URL is unset', () => {
		expect(process.env.DATABASE_URL).toBeUndefined();
		const db = getDb();
		expect(db).toBeDefined();
		expect(existsSync(join(dir, '.data', 'compendium.db'))).toBe(true);
	});
});
