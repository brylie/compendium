import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createDocument as crdtCreateDocument,
	getDocument as crdtGetDocument
} from '$lib/data/document-ops';
import { createRecord as crdtCreateRecord } from '$lib/data/record-ops';
import { remoteUiOrigin, SERVICE_ORIGIN, transactWithOrigin } from '../mutation-origin';
import { DEFAULT_WORKSPACE_ID, resolveWorkspaceContext } from './workspace-store';
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

// Reads a Document's title directly out of its own shard's Yjs snapshot
// (not the catalog's SQL mirror of it) — proves the backup/restore actually
// carries the CRDT content that's the real source of truth, not just the
// derived catalog row. A Document's shard is keyed by its own id (see
// services/documents.ts's createDocument).
function readDocumentTitleFromCrdtShard(dbPath: string, documentId: string): string | undefined {
	const db = new Database(dbPath, { readonly: true });
	let state: Buffer;
	try {
		const row = db
			.prepare(
				'SELECT state FROM snapshots WHERE workspace_id = ? AND shard_id = ? ORDER BY id DESC LIMIT 1'
			)
			.get(DEFAULT_WORKSPACE_ID, documentId) as { state: Buffer } | undefined;
		if (!row) return undefined;
		state = row.state;
	} finally {
		db.close();
	}
	const doc = new Y.Doc();
	Y.applyUpdate(doc, new Uint8Array(state));
	return crdtGetDocument(doc, documentId)?.title;
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
	it('restores a backup file over a target path and the restored database contains the original CRDT document content', () => {
		const document = createDocument(CURRENT_USER, { title: 'Restore Me' });
		const { filePath } = runBackup();

		const restoreDir = mkdtempSync(join(tmpdir(), 'restore-target-'));
		const targetPath = join(restoreDir, 'restored.db');

		restoreFrom(filePath!, targetPath);

		expect(existsSync(targetPath)).toBe(true);
		expect(existsSync(filePath!)).toBe(true); // restore copies, never consumes the backup
		expect(readCatalogTitles(targetPath)).toContain('Restore Me');
		// The catalog row above is a derived SQL mirror — also confirm the
		// actual Yjs source of truth (the document's own shard) round-tripped,
		// not just its projection.
		expect(readDocumentTitleFromCrdtShard(targetPath, document.id)).toBe('Restore Me');

		rmSync(restoreDir, { recursive: true, force: true });
	});

	it('preserves an existing WAL-mode target and its -wal/-shm sidecars aside instead of deleting them', () => {
		createDocument(CURRENT_USER, { title: 'New Content' });
		const { filePath } = runBackup();

		const restoreDir = mkdtempSync(join(tmpdir(), 'restore-target-'));
		const targetPath = join(restoreDir, 'existing.db');

		// A real WAL-mode SQLite database as the pre-existing target, not a
		// placeholder file — proves the pre-restore fallback is a genuinely
		// openable database with its own recoverable content.
		const targetDb = new Database(targetPath);
		targetDb.pragma('journal_mode = WAL');
		targetDb.exec('CREATE TABLE marker (v TEXT)');
		targetDb.prepare('INSERT INTO marker (v) VALUES (?)').run('original-target-content');
		targetDb.close();
		// Sidecars can still exist after a clean close (e.g. wal_autocheckpoint
		// hasn't fired) — simulate that explicitly so the test doesn't depend
		// on exactly when SQLite happens to checkpoint and delete them itself.
		writeFileSync(`${targetPath}-wal`, 'wal-sidecar-content');
		writeFileSync(`${targetPath}-shm`, 'shm-sidecar-content');

		restoreFrom(filePath!, targetPath);

		const files = readdirSync(restoreDir);
		const preRestoreMain = files.find(
			(name) =>
				name.startsWith('existing.db.pre-restore-') &&
				!name.includes('-wal') &&
				!name.includes('-shm')
		);
		const preRestoreWal = files.find(
			(name) => name.startsWith('existing.db.pre-restore-') && name.endsWith('-wal')
		);
		const preRestoreShm = files.find(
			(name) => name.startsWith('existing.db.pre-restore-') && name.endsWith('-shm')
		);

		expect(preRestoreMain).toBeDefined();
		expect(preRestoreWal).toBeDefined();
		expect(preRestoreShm).toBeDefined();
		// The sidecars were moved aside, not deleted, and none are left
		// dangling next to the newly restored target.
		expect(existsSync(`${targetPath}-wal`)).toBe(false);
		expect(existsSync(`${targetPath}-shm`)).toBe(false);

		const preservedDb = new Database(join(restoreDir, preRestoreMain!), { readonly: true });
		try {
			const row = preservedDb.prepare('SELECT v FROM marker').get() as { v: string };
			expect(row.v).toBe('original-target-content');
		} finally {
			preservedDb.close();
		}

		expect(readCatalogTitles(targetPath)).toContain('New Content');

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
