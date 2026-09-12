# Backup and disaster recovery

**Depends on:** [`persistence.md`](./persistence.md), [`workspace-sharding.md`](./workspace-sharding.md) §6

---

## 1. Problem and backup unit

`persistence.md` §1's `snapshots` table and #122's idle-unload flush protect
against a _process_ dying — the worst case there is losing up to
`SAVE_INTERVAL_MS` (30s) of unflushed Yjs updates. Neither protects against
losing the _file_ itself: disk failure, an operator's `rm`, a bad migration,
or a corrupted upgrade. This spec covers that second failure mode — an
external, point-in-time copy of the data, independent of the live process
and its own storage.

Issue #19 asked to revisit the backup unit boundary once #13's workspace/shard
persistence model landed (#112/#113, now shipped). That revisit is resolved
by an observation already true of the shipped design: **every persistence
unit — the Yjs `snapshots` blobs, the workspace catalog, `audit_log`,
`access_tokens`, and the migration manifest — lives in one SQLite file** (see
`db/schema.ts`; there is no separate on-disk file per shard). `record_index`
(persistence.md §2) is the one exception, but it's explicitly a disposable,
rebuildable projection of the Y.Doc state that _is_ backed up — rebuilding it
after a restore is correct and expected, not a gap. So the backup unit is
simply **the whole SQLite file at `DATABASE_URL`**, once per Compendium
instance (`COMPENDIUM_INSTANCE_ID`/`getInstanceWorkspaceId()`). A future
per-shard file split (workspace-sharding.md's Phase B, not yet built) would
need to revisit this again; nothing in the current shipped architecture does.

## 2. Mechanism

A backup is a single `VACUUM INTO` statement (`src/lib/server/db/index.ts`'s
`backupDatabaseTo`) run against the live `better-sqlite3` connection.
`VACUUM INTO` produces a complete, defragmented, directly-openable standalone
copy and is safe to run against a WAL-mode database that's actively being
written to — unlike copying the main file and its `-wal`/`-shm` sidecars with
plain filesystem calls, which can capture a torn, inconsistent read across
the three files. It refuses to overwrite an existing path, so every backup
file gets a unique, sortable name:
`compendium-<workspaceId>-<ISO timestamp>-<sequence>.db`.

Before vacuuming, `runBackup()` (`src/lib/server/backup.ts`) calls
`workspace-store.ts`'s `flush()`, which persists every currently-resolved
workspace context's dirty Yjs state into the `snapshots` table. Without this,
a backup could be _older_ than the last successful snapshot flush, undoing
part of the RPO improvement a backup outside the live process is supposed to
provide. This still cannot capture updates committed in the instant between
the flush and the `VACUUM INTO` call — that residual window is bounded by how
fast a single SQLite statement runs against a personal-scale database (well
under a second at the sizes in the
[capacity baseline](../benchmarks/crdt-capacity-baseline-2026-08-30.md)), not
by `SAVE_INTERVAL_MS`.

## 3. RPO, RTO, retention, and location (Phase 0 defaults)

Phase 0 is a personal, single-instance deployment with no managed-hosting
tier yet (per `docs/prd.md`'s current phase) — the defaults below are sized
for that, not for a multi-tenant SLA, and are all operator-configurable via
environment variables read fresh on every call (matching `instance.ts`'s
`getInstanceWorkspaceId` convention, so a long-running process picks up a
config change without a restart):

| Concern   | Default                                             | Env var                  |
| --------- | --------------------------------------------------- | ------------------------ |
| RPO       | 1 hour (a backup runs every hour)                   | `BACKUP_INTERVAL_MS`     |
| Retention | last 24 backups (~1 day at the default interval)    | `BACKUP_RETENTION_COUNT` |
| Location  | `.data/backups/` (sibling to `.data/compendium.db`) | `BACKUP_DIR`             |

**RTO:** restoring is copying one backup file over the live `DATABASE_URL`
path and restarting the server — no replay, migration, or reconciliation
step, since a `VACUUM INTO` output is already a normal, directly-openable
SQLite file. At the personal-workspace sizes this repo currently measures
(low single-digit MiB, per the capacity baseline), that copy and the
subsequent server startup (which lazily reloads the one default
workspace/shard context per `persistence.md` §1) complete in seconds. RTO
scales with database file size and is a copy operation, not a computation —
re-measure against the capacity baseline's larger profile
(`npm run benchmark:workspace:large`) if this stops being true at a larger
workspace size.

Retention is a flat file count, not a tiered daily/weekly/monthly scheme —
the same simplicity tradeoff `store.ts`'s existing `SNAPSHOT_RETENTION = 5`
already makes for in-DB Yjs snapshots. A self-hoster who wants longer
retention or off-host copies raises `BACKUP_RETENTION_COUNT` and/or points
`BACKUP_DIR` at a synced/mounted location (e.g. a cloud-synced folder) —
Compendium does not implement off-host replication itself.

## 4. Failure visibility

Every backup attempt — scheduled or manual — writes one row to the
`backup_runs` table (`src/lib/server/db/schema.ts`): `status`
(`'success' | 'failure'`), `filePath`, `sizeBytes`, and `error` when it
failed. This is deliberately a normal queryable table, not a log line alone,
so "has backup been silently failing" is answerable with a SQL query against
the live database rather than only by grepping process logs that may have
rotated away. `runBackup()` also `console.error`s on failure, matching
`workspace-store.ts`'s `flushContext` catch-and-log convention for the
scheduled path (`wireBackupScheduleOnce`, wired from `server.ts`), which must
never let a failed backup crash the running server.

**Managed-deployment alerting is out of scope for this issue/phase.**
Phase 0 has no managed-hosting tier to alert on behalf of (see `docs/prd.md`
Non-Goals) — `backup_runs` is the seam a future managed deployment's
alerting would read from (e.g. a health-check endpoint querying the most
recent row's age and status), but building that alerting path now would be
speculative infrastructure for a deployment model that doesn't exist yet.
This is a deliberate deferral, not a silently dropped requirement.

## 5. Restore procedure (documented and tested)

1. Stop the server. Restoring into a live `DATABASE_URL` file the process
   still holds open is unsupported — the running process would keep its
   stale in-memory `Y.Doc`/connection state after the file underneath it
   changes.
2. Pick a backup file from `BACKUP_DIR` (filenames sort chronologically).
3. Run `npm run db:restore -- --file=<path>` (`scripts/restore-workspace.ts`,
   `restoreFrom` in `backup.ts`). It defaults the target to `DATABASE_URL`;
   pass `--target=<path>` to restore somewhere else (e.g. to inspect a backup
   without touching the live file).
4. `restoreFrom` verifies the backup with `PRAGMA integrity_check` before
   touching anything, moves any existing file at the target aside to
   `<target>.pre-restore-<timestamp>` (never deletes it outright), removes
   any stale `-wal`/`-shm` sidecars next to the target (a leftover WAL from
   the file being replaced would otherwise reference frames for a database
   that no longer exists), and copies the backup into place. The backup file
   itself is copied, not moved, so it remains available for a repeat attempt.
5. Start the server and verify the data.

`src/lib/server/backup.test.ts` exercises this procedure directly (backup a
real workspace's content, restore it into a fresh target path, reopen and
assert the content round-trips), plus the retention-pruning and
failure-recording paths — see "Testing model" in the top-level `CLAUDE.md`
for why this lives as a direct server-project test rather than a Tier A/B
E2E test: restore is a filesystem/SQLite-level operation with no MCP↔Yjs
transport boundary to cross, so a unit-level test against the real
`better-sqlite3` file is the actual failure boundary here, not a protocol
client.

## 6. What this does not cover

- **Off-host/offsite copies.** `BACKUP_DIR` is a local (or locally-mounted)
  path; getting backups off the machine is an operator/deployment concern
  (rsync, a synced folder, a cron job copying `BACKUP_DIR` elsewhere), not
  something this module implements.
- **Point-in-time recovery finer than the backup interval.** Restoring always
  lands on the timestamp of a specific backup file, not an arbitrary moment
  between backups — lower `BACKUP_INTERVAL_MS` for a tighter RPO if needed.
- **Per-workspace selective restore.** A restore replaces the entire
  database file, all workspaces/instances included — there's no
  per-`workspaceId` extraction. Fits Phase 0's one-instance-per-process
  deployment model; would need revisiting alongside true multi-tenant
  hosting.
