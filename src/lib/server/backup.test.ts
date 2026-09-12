import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDocument as crdtCreateDocument } from '$lib/data/document-ops';
import { createRecord as crdtCreateRecord } from '$lib/data/record-ops';
import { remoteUiOrigin, SERVICE_ORIGIN, transactWithOrigin } from '../mutation-origin';
import { resolveWorkspaceContext } from './workspace-store';
import { createDocument } from '../services';
import { CURRENT_USER } from './current-user';
import { getDb } from './store';
import { backupRuns } from './db/schema';
import { getBackupDir, restoreFrom, runBackup } from './backup';

// isolate-persistence.ts (tests/setup) already gives every test in this
// project its own temp DATABASE_URL — BACKUP_DIR has no equivalent global
// isolation, so each test here manages its own.
let backupDir: string;

beforeEach(() => {
	backupDir = mkdtempSync(join(tmpdir(), 'backup-dir-'));
	process.env.BACKUP_DIR = backupDir;
});

afterEach(() => {
	delete process.env.BACKUP_DIR;
	delete process.env.BACKUP_RETENTION_COUNT;
	rmSync(backupDir, { recursive: true, force: true });
});

function readCatalogTitles(dbPath: string): string[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.prepare('SELECT title FROM catalog_documents')
			.all()
			.map((row) => (row as { title: string }).title);
	} finally {
		db.close();
	}
}

function readAuditActionsFor(dbPath: string, targetRecordId: string): string[] {
	const db = new Database(dbPath, { readonly: true });
	try {
		return db
			.prepare('SELECT action FROM audit_log WHERE target_record_id = ?')
			.all(targetRecordId)
			.map((row) => (row as { action: string }).action);
	} finally {
		db.close();
	}
}

describe('backup: runBackup (#19)', () => {
	it('writes a standalone, openable copy of the database containing already-committed content', () => {
		createDocument(CURRENT_USER, { title: 'Backed Up Doc' });

		const result = runBackup();

		expect(result.status).toBe('success');
		expect(result.filePath).toBeDefined();
		expect(existsSync(result.filePath!)).toBe(true);
		expect(result.sizeBytes).toBeGreaterThan(0);
		expect(readCatalogTitles(result.filePath!)).toContain('Backed Up Doc');
	});

	it('records a success row in backup_runs', () => {
		const before = getDb().select().from(backupRuns).all().length;

		const result = runBackup();

		const rows = getDb().select().from(backupRuns).all();
		expect(rows).toHaveLength(before + 1);
		const latest = rows[rows.length - 1];
		expect(latest.status).toBe('success');
		expect(latest.filePath).toBe(result.filePath);
	});

	it('prunes backup files beyond BACKUP_RETENTION_COUNT, keeping the newest', () => {
		process.env.BACKUP_RETENTION_COUNT = '2';

		const first = runBackup();
		const second = runBackup();
		const third = runBackup();

		const remaining = readdirSync(getBackupDir()).sort((a, b) => a.localeCompare(b));
		expect(remaining).toHaveLength(2);
		expect(remaining).not.toContain(first.filePath!.split('/').pop());
		expect(remaining).toContain(second.filePath!.split('/').pop());
		expect(remaining).toContain(third.filePath!.split('/').pop());
	});

	it('flushes a pending debounced audit event before copying the database, so the backup never contains an edit without its audit row', () => {
		const { doc } = resolveWorkspaceContext();
		const parent = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			crdtCreateDocument(doc, { title: 'Parent' })
		);
		const record = transactWithOrigin(doc, SERVICE_ORIGIN, () =>
			crdtCreateRecord(doc, { parentId: parent.id, blockType: 'paragraph' }, CURRENT_USER)
		);
		const yrecord = doc.getMap('records').get(record.id) as Y.Map<unknown>;
		const content = yrecord.get('content') as Y.Text;

		// A direct client-origin edit (bypassing the service layer, as a real
		// UI edit does) starts a 3s debounce window before its update_record
		// audit row is written — see audit-observer.ts. Backing up
		// immediately, well within that window, must not race it.
		const REMOTE_UI_ORIGIN = remoteUiOrigin('backup-test');
		doc.transact(() => content.insert(0, 'edited just before backup'), REMOTE_UI_ORIGIN);

		const { filePath } = runBackup();

		expect(readAuditActionsFor(filePath!, record.id)).toContain('update_record');
	});

	it('records a failure row and rethrows when the backup destination cannot be created', () => {
		// A regular file where BACKUP_DIR should be makes mkdirSync(..., {recursive: true}) throw ENOTDIR.
		const blocker = join(backupDir, 'not-a-directory');
		writeFileSync(blocker, '');
		process.env.BACKUP_DIR = join(blocker, 'nested');

		expect(() => runBackup()).toThrow();

		const rows = getDb().select().from(backupRuns).all();
		const latest = rows[rows.length - 1];
		expect(latest.status).toBe('failure');
		expect(latest.error).toBeTruthy();
	});
});

describe('backup: restoreFrom (#19)', () => {
	it('restores a backup file over a target path and the restored database contains the original content', () => {
		createDocument(CURRENT_USER, { title: 'Restore Me' });
		const { filePath } = runBackup();

		const restoreDir = mkdtempSync(join(tmpdir(), 'restore-target-'));
		const targetPath = join(restoreDir, 'restored.db');

		restoreFrom(filePath!, targetPath);

		expect(existsSync(targetPath)).toBe(true);
		expect(existsSync(filePath!)).toBe(true); // restore copies, never consumes the backup
		expect(readCatalogTitles(targetPath)).toContain('Restore Me');

		rmSync(restoreDir, { recursive: true, force: true });
	});

	it('preserves an existing target file aside instead of deleting it', () => {
		const { filePath } = runBackup();

		const restoreDir = mkdtempSync(join(tmpdir(), 'restore-target-'));
		const targetPath = join(restoreDir, 'existing.db');
		writeFileSync(targetPath, 'not a real database, just marking pre-restore content');

		restoreFrom(filePath!, targetPath);

		const preserved = readdirSync(restoreDir).find((name) =>
			name.startsWith('existing.db.pre-restore-')
		);
		expect(preserved).toBeDefined();

		rmSync(restoreDir, { recursive: true, force: true });
	});

	it('throws on a nonexistent backup file without touching the target', () => {
		const restoreDir = mkdtempSync(join(tmpdir(), 'restore-target-'));
		const targetPath = join(restoreDir, 'target.db');

		expect(() => restoreFrom(join(backupDir, 'missing.db'), targetPath)).toThrow();
		expect(existsSync(targetPath)).toBe(false);

		rmSync(restoreDir, { recursive: true, force: true });
	});

	it('rejects restoring a file onto itself instead of stranding it under a pre-restore name', () => {
		const { filePath } = runBackup();

		expect(() => restoreFrom(filePath!, filePath!)).toThrow(/restoring a backup onto itself/i);
		// The file must still be exactly where it was — not renamed aside.
		expect(existsSync(filePath!)).toBe(true);
	});
});
