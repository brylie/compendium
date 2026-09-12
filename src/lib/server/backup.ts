// Automated backup and disaster recovery (#19). Distinct from the
// `snapshots` table in store.ts, which persists Yjs state *inside* the same
// SQLite file the live server writes to — that protects against a process
// crash losing unflushed in-memory edits, but does nothing if the file
// itself is lost, corrupted, or the disk fails. This module produces a
// standalone copy of the whole database (catalog, snapshots, audit log,
// tokens, migration manifests — every persistence unit lives in one SQLite
// file, see docs/specifications/persistence.md §1) at a separate location,
// on a schedule, with retention and failure visibility. See
// docs/specifications/backup-recovery.md for the design this implements.
import {
	copyFileSync,
	mkdirSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	existsSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { backupDatabaseTo, getDb } from './db/index.js';
import { backupRuns } from './db/schema.js';
import { flush } from './workspace-store.js';
import { getInstanceWorkspaceId } from './instance.js';

const DEFAULT_BACKUP_DIR = '.data/backups';
const DEFAULT_BACKUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_BACKUP_RETENTION_COUNT = 24; // ~1 day of hourly backups by default

const FILENAME_PREFIX = 'compendium-';
const FILENAME_SUFFIX = '.db';

/**
 * Directory backups are written to. Read fresh on every call, not cached —
 * same rationale as instance.ts's getInstanceWorkspaceId: a test (or an
 * operator reconfiguring a long-running process) that changes the env var
 * must see the change on the next backup, not whatever was resolved at
 * first call.
 */
export function getBackupDir(): string {
	return process.env.BACKUP_DIR ?? DEFAULT_BACKUP_DIR;
}

/** Milliseconds between scheduled backups (the RPO target). Read fresh — see getBackupDir. */
export function getBackupIntervalMs(): number {
	const raw = process.env.BACKUP_INTERVAL_MS;
	const parsed = raw ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BACKUP_INTERVAL_MS;
}

/** Number of backup files to retain before older ones are pruned. Read fresh — see getBackupDir. */
export function getBackupRetentionCount(): number {
	const raw = process.env.BACKUP_RETENTION_COUNT;
	const parsed = raw ? Number(raw) : NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BACKUP_RETENTION_COUNT;
}

export interface BackupRunResult {
	status: 'success' | 'failure';
	filePath?: string;
	sizeBytes?: number;
	error?: string;
}

// Disambiguates filenames created within the same millisecond (e.g. back to
// back manual + scheduled runs, or a fast test loop) without depending on
// clock resolution — only one backup ever runs at a time in a given process,
// so a module-scope counter is sufficient.
let sequence = 0;

function backupFilePath(dir: string, workspaceId: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	return join(dir, `${FILENAME_PREFIX}${workspaceId}-${stamp}-${sequence++}${FILENAME_SUFFIX}`);
}

function recordRun(startedAt: number, result: BackupRunResult, workspaceId: string): void {
	getDb()
		.insert(backupRuns)
		.values({
			workspaceId,
			startedAt,
			finishedAt: Date.now(),
			status: result.status,
			filePath: result.filePath,
			sizeBytes: result.sizeBytes,
			error: result.error
		})
		.run();
}

/**
 * Deletes the oldest backup files in `dir` beyond `retentionCount`, ranked
 * by filename — safe because every filename embeds an ISO timestamp
 * (zero-padded by `Date.toISOString()`) followed by the disambiguating
 * sequence number, so lexicographic order matches creation order exactly.
 * Only touches files matching this module's own naming convention, so a
 * BACKUP_DIR an operator points at an existing directory never loses
 * unrelated files.
 */
function pruneOldBackups(dir: string, retentionCount: number): void {
	// dir is always this module's own getBackupDir() (server config, not
	// request input) — see the trust-boundary note on db/index.ts's
	// mkdirSync/backupDatabaseTo, which this mirrors for every fs call below.
	// eslint-disable-next-line security/detect-non-literal-fs-filename
	const files = readdirSync(dir)
		.filter((name) => name.startsWith(FILENAME_PREFIX) && name.endsWith(FILENAME_SUFFIX))
		.sort((a, b) => a.localeCompare(b));
	const toDelete = files.slice(0, Math.max(0, files.length - retentionCount));
	for (const name of toDelete) {
		// eslint-disable-next-line security/detect-non-literal-fs-filename
		unlinkSync(join(dir, name));
	}
}

/**
 * Performs one backup attempt: flushes every live workspace context's dirty
 * Yjs state first (so the backup captures the freshest snapshot rows rather
 * than whatever was on disk up to SAVE_INTERVAL_MS ago), then `VACUUM INTO`s
 * a timestamped copy of the whole database into BACKUP_DIR, prunes old
 * backups beyond retention, and records the outcome in `backup_runs`.
 *
 * Throws on failure after logging and recording it — callers that must
 * never crash a long-running process (the scheduled tick below) catch and
 * log instead of calling this directly; a one-shot CLI invocation
 * (scripts/backup-workspace.ts) lets the failure propagate to a non-zero
 * exit code.
 */
export function runBackup(): BackupRunResult {
	const startedAt = Date.now();
	const workspaceId = getInstanceWorkspaceId();
	const dir = getBackupDir();

	try {
		flush();
		// dir is getBackupDir()'s own server config, not request input.
		// eslint-disable-next-line security/detect-non-literal-fs-filename
		mkdirSync(dir, { recursive: true });
		const filePath = backupFilePath(dir, workspaceId);
		backupDatabaseTo(filePath);
		// filePath is generated by backupFilePath() above, not request input.
		// eslint-disable-next-line security/detect-non-literal-fs-filename
		const sizeBytes = statSync(filePath).size;

		const result: BackupRunResult = { status: 'success', filePath, sizeBytes };
		recordRun(startedAt, result, workspaceId);
		pruneOldBackups(dir, getBackupRetentionCount());
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const result: BackupRunResult = { status: 'failure', error: message };
		console.error('Backup failed', error);
		try {
			recordRun(startedAt, result, workspaceId);
		} catch (recordError) {
			// The database itself may be unreachable — the console.error above
			// is the last-resort failure signal in that case.
			console.error('Failed to record backup failure', recordError);
		}
		throw error;
	}
}

declare global {
	var __backupScheduleWired: boolean | undefined;
}

/**
 * Wires the recurring backup timer once per process, mirroring
 * workspace-store.ts's wireIdleSweepOnce/wireShutdownOnce. Called from
 * server.ts, the real deployment entry point (`npm run build && npm start`)
 * — backup is a whole-database, process-level concern independent of any
 * particular workspace/shard context, unlike the idle sweep/shutdown hooks
 * this mirrors, so it isn't wired from workspace-store.ts's createContext()
 * (which would also create a circular import between the two modules, since
 * runBackup() below calls workspace-store.ts's flush()). The timer is
 * `unref()`'d and the tick swallows its own errors, so calling this is inert
 * overhead in short-lived processes.
 */
export function wireBackupScheduleOnce(): void {
	if (globalThis.__backupScheduleWired) return;
	globalThis.__backupScheduleWired = true;
	const timer = setInterval(() => {
		try {
			runBackup();
		} catch {
			// Already logged and recorded inside runBackup(); the schedule must
			// keep ticking regardless.
		}
	}, getBackupIntervalMs());
	timer.unref?.();
}

/**
 * Restores `sourcePath` (a backup produced by runBackup, or any valid
 * standalone SQLite file) over `targetPath` — the live DATABASE_URL path in
 * practice. Verifies the source with `PRAGMA integrity_check` before
 * touching anything. If `targetPath` already exists, it's renamed aside to
 * `<targetPath>.pre-restore-<timestamp>` rather than deleted, so an operator
 * who restores the wrong file can still recover the previous state. Also
 * removes any stale `-wal`/`-shm` sidecars next to `targetPath`: a leftover
 * WAL from the previous database would otherwise contain frames for a file
 * that no longer exists once the main file is replaced.
 */
export function restoreFrom(sourcePath: string, targetPath: string): void {
	// sourcePath/targetPath come from an operator invoking scripts/restore-workspace.ts
	// (CLI args / DATABASE_URL), never from a request — same trust boundary as
	// DATABASE_URL itself (see db/index.ts).
	// eslint-disable-next-line security/detect-non-literal-fs-filename
	if (!existsSync(sourcePath)) {
		throw new Error(`Backup file not found: ${sourcePath}`);
	}

	const check = new Database(sourcePath, { readonly: true });
	let result: string;
	try {
		result = check.pragma('integrity_check', { simple: true }) as string;
	} finally {
		check.close();
	}
	if (result !== 'ok') {
		throw new Error(`Backup file failed integrity check: ${result}`);
	}

	// eslint-disable-next-line security/detect-non-literal-fs-filename
	mkdirSync(dirname(targetPath), { recursive: true });

	// eslint-disable-next-line security/detect-non-literal-fs-filename
	if (existsSync(targetPath)) {
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		// eslint-disable-next-line security/detect-non-literal-fs-filename
		renameSync(targetPath, `${targetPath}.pre-restore-${stamp}`);
	}
	for (const suffix of ['-wal', '-shm']) {
		const sidecar = `${targetPath}${suffix}`;
		// eslint-disable-next-line security/detect-non-literal-fs-filename
		if (existsSync(sidecar)) unlinkSync(sidecar);
	}

	// Copy rather than move: the backup file must remain available in
	// BACKUP_DIR for a future restore attempt.
	copyFileSync(sourcePath, targetPath);
}
