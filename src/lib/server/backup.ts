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
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { backupDatabaseTo, getDb } from './db/index.js';
import { backupRuns } from './db/schema.js';
import { flush } from './workspace-store.js';
import { flushPendingAuditEvents } from './audit-observer.js';
import { flushPendingCatalogMirrorEvents } from './catalog-mirror-observer.js';
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

/**
 * Milliseconds between scheduled backups (the RPO target). Read fresh — see
 * getBackupDir. Throws if `BACKUP_INTERVAL_MS` is set but not a positive
 * number — an operator who mistypes it must find out, not silently get the
 * default while believing a different RPO is active. Only absent from the
 * environment entirely does this fall back to the default.
 */
export function getBackupIntervalMs(): number {
	const raw = process.env.BACKUP_INTERVAL_MS;
	if (raw === undefined) return DEFAULT_BACKUP_INTERVAL_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(
			`BACKUP_INTERVAL_MS must be a positive number of milliseconds; got ${JSON.stringify(raw)}.`
		);
	}
	return parsed;
}

/**
 * Number of backup files to retain before older ones are pruned. Read
 * fresh, with the same "throw if present but invalid" contract as
 * getBackupIntervalMs — see there for why.
 */
export function getBackupRetentionCount(): number {
	const raw = process.env.BACKUP_RETENTION_COUNT;
	if (raw === undefined) return DEFAULT_BACKUP_RETENTION_COUNT;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(
			`BACKUP_RETENTION_COUNT must be a positive whole number; got ${JSON.stringify(raw)}.`
		);
	}
	return parsed;
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

// COMPENDIUM_INSTANCE_ID is operator-configured (instance.ts) for display and
// as a DB column value, not validated for filesystem safety — sanitize
// before using it in a path so a value containing "/" or ".." can't create
// an unintended nested destination or escape BACKUP_DIR.
function sanitizeForFilename(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * A collision-resistant filename component for one instance's backups.
 * `sanitizeForFilename` alone isn't enough to scope `pruneOldBackups` to
 * only this instance's files: two different raw workspace ids that
 * sanitize to the same string (e.g. "a/b" and "a_b") would otherwise share
 * one namespace, letting one instance prune another's backups if they're
 * ever pointed at the same BACKUP_DIR (a synced or mounted directory
 * shared across instances). Appending a short hash of the *unsanitized* id
 * disambiguates them.
 */
function instanceNamespace(workspaceId: string): string {
	const hash = createHash('sha256').update(workspaceId).digest('hex').slice(0, 8);
	return `${sanitizeForFilename(workspaceId)}-${hash}`;
}

function backupFilePath(dir: string, workspaceId: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	return join(
		dir,
		`${FILENAME_PREFIX}${instanceNamespace(workspaceId)}-${stamp}-${sequence++}${FILENAME_SUFFIX}`
	);
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
 * Deletes the oldest backup files belonging to `workspaceId` in `dir`
 * beyond `retentionCount`, ranked by filename — safe because every
 * filename embeds an ISO timestamp (zero-padded by `Date.toISOString()`)
 * followed by the disambiguating sequence number, so lexicographic order
 * matches creation order exactly. Scoped to this instance's own namespace
 * (see `instanceNamespace`), not just this module's generic filename
 * convention — a BACKUP_DIR shared (via a synced or mounted directory)
 * across more than one Compendium instance must never let one instance's
 * retention pruning delete another's backups, and an operator pointing
 * BACKUP_DIR at an existing directory must never lose unrelated files.
 */
function pruneOldBackups(dir: string, retentionCount: number, workspaceId: string): void {
	const ownPrefix = `${FILENAME_PREFIX}${instanceNamespace(workspaceId)}-`;
	// dir is always this module's own getBackupDir() (server config, not
	// request input) — see the trust-boundary note on db/index.ts's
	// mkdirSync/backupDatabaseTo, which this mirrors for every fs call below.
	// eslint-disable-next-line security/detect-non-literal-fs-filename
	const files = readdirSync(dir)
		.filter((name) => name.startsWith(ownPrefix) && name.endsWith(FILENAME_SUFFIX))
		.sort((a, b) => a.localeCompare(b));
	const toDelete = files.slice(0, Math.max(0, files.length - retentionCount));
	for (const name of toDelete) {
		// eslint-disable-next-line security/detect-non-literal-fs-filename
		unlinkSync(join(dir, name));
	}
}

/**
 * Performs one backup attempt: flushes every pending debounced audit event
 * and catalog mirror write, then every live workspace context's dirty Yjs
 * state (in that order — the same ordering wireShutdownOnce uses to make a
 * graceful shutdown durable, since a backup is conceptually "capture durable
 * state as if the process stopped right now" without actually stopping).
 * Skipping the audit/catalog flush would let a backup capture a Yjs edit
 * whose audit_log row is still sitting in the observer's debounce window,
 * producing a restored database with content the audit trail never
 * mentions. Then `VACUUM INTO`s a timestamped copy of the whole database
 * into BACKUP_DIR and records the outcome in `backup_runs` — retention
 * pruning happens after that record is written and its own failure is
 * logged, not treated as a failure of the backup that already succeeded
 * (see pruneOldBackups's caller below).
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
		flushPendingAuditEvents();
		flushPendingCatalogMirrorEvents();
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
		try {
			pruneOldBackups(dir, getBackupRetentionCount(), workspaceId);
		} catch (pruneError) {
			// The backup itself already succeeded and is already recorded as
			// such — a directory-read or unlink failure while trimming old
			// backups is a separate, lower-severity problem and must not turn
			// into a second, contradictory `backup_runs` row or make a
			// successful backup look like a failed one to the caller.
			console.error('Backup succeeded but retention pruning failed', pruneError);
		}
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
 * runBackup() below calls workspace-store.ts's flush()).
 *
 * Self-reschedules with `setTimeout` rather than a single fixed
 * `setInterval`, re-reading `getBackupIntervalMs()` before scheduling each
 * next run — every other config getter here is documented as "read fresh on
 * every call" specifically so an operator can reconfigure a long-running
 * process without restarting it; a `setInterval` captured once at wire time
 * would silently keep the old cadence until the next restart instead. Each
 * timer is `unref()`'d and the tick swallows its own errors, so calling this
 * is inert overhead in short-lived processes.
 */
export function wireBackupScheduleOnce(): void {
	if (globalThis.__backupScheduleWired) return;
	globalThis.__backupScheduleWired = true;
	scheduleNextBackup();
}

function scheduleNextBackup(): void {
	// getBackupIntervalMs() throws on a present-but-invalid env var (by
	// design, so a typo is visible rather than silently defaulted) — but
	// this call site drives a recurring timer that must never crash the
	// server process over a config mistake, so it falls back to the default
	// interval and logs instead of propagating.
	let intervalMs: number;
	try {
		intervalMs = getBackupIntervalMs();
	} catch (error) {
		console.error(
			'Invalid BACKUP_INTERVAL_MS; using the default backup interval until it is fixed',
			error
		);
		intervalMs = DEFAULT_BACKUP_INTERVAL_MS;
	}
	const timer = setTimeout(() => {
		try {
			runBackup();
		} catch {
			// Already logged and recorded inside runBackup(); the schedule must
			// keep ticking regardless.
		} finally {
			scheduleNextBackup();
		}
	}, intervalMs);
	timer.unref?.();
}

const WAL_SIDECAR_SUFFIXES = ['-wal', '-shm'];

/** Throws unless `PRAGMA integrity_check` on `dbPath` reports 'ok'. */
function assertIntegrity(dbPath: string): void {
	const check = new Database(dbPath, { readonly: true });
	let result: string;
	try {
		result = check.pragma('integrity_check', { simple: true }) as string;
	} finally {
		check.close();
	}
	if (result !== 'ok') {
		throw new Error(`Backup file failed integrity check: ${result}`);
	}
}

/**
 * Renames `${fromBase}-wal`/`${fromBase}-shm` to `${toBase}-wal`/`${toBase}-shm`
 * wherever they exist. Used both to carry an existing target's sidecars
 * along when it's moved aside (so an unflushed WAL's committed-but-not-yet-
 * checkpointed frames stay recoverable from the pre-restore fallback) and,
 * symmetrically, to roll that same move back if the final replace fails.
 */
function moveSidecarsAside(fromBase: string, toBase: string): void {
	for (const suffix of WAL_SIDECAR_SUFFIXES) {
		const from = `${fromBase}${suffix}`;
		// eslint-disable-next-line security/detect-non-literal-fs-filename
		if (existsSync(from)) renameSync(from, `${toBase}${suffix}`);
	}
}

/**
 * Restores `sourcePath` (a backup produced by runBackup, or any valid
 * standalone SQLite file) over `targetPath` — the live DATABASE_URL path in
 * practice. Verifies the source with `PRAGMA integrity_check` before
 * touching anything, and rejects a `sourcePath`/`targetPath` pair that
 * resolve to the same file (restoring a file onto itself is never a valid
 * operation and would otherwise strand the target under its own
 * pre-restore name — see below).
 *
 * The replacement itself is copy-then-rename, not copy-onto-target
 * directly: `sourcePath` is first copied to a staging file next to
 * `targetPath`, so a failure partway through the copy (disk full,
 * permissions) never touches the existing target at all. Only once that
 * staging copy has fully succeeded does an existing `targetPath` (and its
 * `-wal`/`-shm` sidecars, if present — preserved rather than deleted, since
 * an unflushed WAL can hold committed frames never checkpointed into the
 * main file, which the pre-restore fallback would otherwise be silently
 * missing) get renamed aside to `<targetPath>.pre-restore-<timestamp>`
 * (and matching suffixed names), and the staged file renamed into `targetPath`.
 * If that final rename fails, the pre-restore files are renamed back into
 * place so the configured path is never left without an openable database.
 */
export function restoreFrom(sourcePath: string, targetPath: string): void {
	// sourcePath/targetPath come from an operator invoking scripts/restore-workspace.ts
	// (CLI args / DATABASE_URL), never from a request — same trust boundary as
	// DATABASE_URL itself (see db/index.ts).
	// eslint-disable-next-line security/detect-non-literal-fs-filename
	if (!existsSync(sourcePath)) {
		throw new Error(`Backup file not found: ${sourcePath}`);
	}
	if (resolve(sourcePath) === resolve(targetPath)) {
		throw new Error(
			`Source and target both resolve to ${resolve(targetPath)} — restoring a backup onto itself is not supported.`
		);
	}
	assertIntegrity(sourcePath);

	// eslint-disable-next-line security/detect-non-literal-fs-filename
	mkdirSync(dirname(targetPath), { recursive: true });

	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const stagedPath = `${targetPath}.restoring-${stamp}`;
	// Copy (never move) from sourcePath: it must remain available in
	// BACKUP_DIR for a future restore attempt, and a failure here must not
	// have touched targetPath at all yet.
	copyFileSync(sourcePath, stagedPath);

	// eslint-disable-next-line security/detect-non-literal-fs-filename
	const targetExisted = existsSync(targetPath);
	const preRestorePath = `${targetPath}.pre-restore-${stamp}`;
	// Tracks whether the main file actually got renamed aside — not the same
	// as targetExisted: if targetExisted but the sidecar move below throws
	// partway through, the main file has already moved even though the
	// preservation step as a whole didn't complete. The catch block must
	// roll back exactly when the main file moved, not merely when a target
	// existed to begin with.
	let targetMoved = false;

	try {
		if (targetExisted) {
			// eslint-disable-next-line security/detect-non-literal-fs-filename
			renameSync(targetPath, preRestorePath);
			targetMoved = true;
		}
		// Unconditional, not nested inside `if (targetExisted)`: a stale
		// -wal/-shm sidecar can outlive its main file (e.g. the main file
		// was deleted manually, or a prior crash left orphaned sidecars) —
		// leaving those next to the freshly restored main file risks SQLite
		// treating them as its own WAL on next open. moveSidecarsAside is
		// already a per-suffix existsSync-guarded no-op when nothing is
		// there, so calling it regardless of targetExisted is always safe.
		moveSidecarsAside(targetPath, preRestorePath);
		// eslint-disable-next-line security/detect-non-literal-fs-filename
		renameSync(stagedPath, targetPath);
	} catch (error) {
		// Roll back: put the previous database (and its sidecars) back
		// exactly where they were rather than leaving the configured path
		// with nothing openable. Sidecars are rolled back unconditionally
		// for the same reason they're moved aside unconditionally above.
		if (targetMoved) {
			// eslint-disable-next-line security/detect-non-literal-fs-filename
			renameSync(preRestorePath, targetPath);
		}
		moveSidecarsAside(preRestorePath, targetPath);
		// eslint-disable-next-line security/detect-non-literal-fs-filename
		if (existsSync(stagedPath)) unlinkSync(stagedPath);
		throw error;
	}
}
