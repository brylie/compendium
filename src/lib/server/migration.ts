import * as Y from 'yjs';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb, getSnapshotStore } from './store.js';
import {
	DEFAULT_SHARD_ID,
	DEFAULT_WORKSPACE_ID,
	resolveWorkspaceContext
} from './workspace-store.js';
import {
	catalogCollections,
	catalogDocuments,
	migrationRuns,
	migrationTargets,
	recordLocator
} from './db/schema.js';
import {
	copyCollectionVerbatim,
	copyDocumentVerbatim,
	listCollections as crdtListCollections,
	listDocuments as crdtListDocuments
} from '../data/records.js';
import type { CollectionMeta, DocumentMeta } from '../data/types.js';

// Moves every legacy Document/Collection — content still living in the
// shared default shard because it predates the catalog/shard system (#113)
// — into its own real per-record shard, per docs/specifications/
// workspace-sharding.md §7. Distinct from catalog.ts's
// ensureCatalogBootstrapped, which only backfills catalog/locator rows
// pointing at content that stays exactly where it is; this module actually
// relocates the content and is the versioned, checksum-verified, idempotent
// migration §7 describes.
//
// Idempotency key: one `migrationRuns` row per (workspaceId,
// migrationVersion) — reused across invocations regardless of whether more
// legacy content has appeared in the meantime, since the legacy doc is never
// pruned (§7: it "remains a read-only legacy recovery unit... until an
// explicit retention policy permits removal") and so always re-lists every
// Document/Collection ever created there, migrated or not. Per-target
// idempotency lives in `migrationTargets`, keyed by (runId, legacyId) —
// already-`durable` targets are skipped on every re-run; only genuinely new
// legacy content (created directly via Yjs sync since the last run) gets
// processed. `legacySnapshotId` is captured once, at first-run time, as a
// stable provenance identifier — it is not re-derived per call.

export const MIGRATION_VERSION = 'v1';

export interface MigrationResult {
	runId: number;
	dryRun: boolean;
	targetsMigrated: string[];
	targetsAlreadyDurable: string[];
}

/**
 * Looked up by (workspaceId, migrationVersion) alone, not by
 * legacySnapshotId — that column is provenance recorded on creation, not a
 * lookup key, since a caller re-running the migration doesn't know it in
 * advance and content arriving in the legacy doc between runs must not fork
 * a second run.
 */
function findExistingRun(workspaceId: string): { id: number } | undefined {
	return getDb()
		.select({ id: migrationRuns.id })
		.from(migrationRuns)
		.where(
			and(
				eq(migrationRuns.workspaceId, workspaceId),
				eq(migrationRuns.migrationVersion, MIGRATION_VERSION)
			)
		)
		.get();
}

function createRun(workspaceId: string, legacyDoc: Y.Doc): { id: number } {
	const legacySnapshotId = createHash('sha256')
		.update(Y.encodeStateAsUpdate(legacyDoc))
		.digest('hex');
	const now = Date.now();
	const inserted = getDb()
		.insert(migrationRuns)
		.values({
			workspaceId,
			legacySnapshotId,
			migrationVersion: MIGRATION_VERSION,
			status: 'running',
			startedAt: now
		})
		.returning({ id: migrationRuns.id })
		.get();
	return { id: inserted.id };
}

type Target =
	| { legacyId: string; kind: 'document'; meta: DocumentMeta }
	| { legacyId: string; kind: 'collection'; meta: CollectionMeta };

function discoverTargets(legacyDoc: Y.Doc): Target[] {
	const documents = crdtListDocuments(legacyDoc).map((meta): Target => ({
		legacyId: meta.id,
		kind: 'document',
		meta
	}));
	const collections = crdtListCollections(legacyDoc).map((meta): Target => ({
		legacyId: meta.id,
		kind: 'collection',
		meta
	}));
	return [...documents, ...collections];
}

function isDurable(runId: number, legacyId: string): boolean {
	const row = getDb()
		.select({ durable: migrationTargets.durable })
		.from(migrationTargets)
		.where(and(eq(migrationTargets.runId, runId), eq(migrationTargets.legacyId, legacyId)))
		.get();
	return row?.durable ?? false;
}

/**
 * Migrates one target: copies its content into a fresh real shard, snapshots
 * and checksums that shard, then upserts the catalog/locator rows to point
 * at it (in-place UPDATE if ensureCatalogBootstrapped already created a
 * placeholder row for this id at the default shard — see this module's own
 * top comment), and marks the manifest target durable. All DB writes happen
 * in one transaction so a crash mid-target never leaves a half-migrated
 * catalog/locator pair.
 */
function migrateTarget(
	workspaceId: string,
	defaultSpaceId: string,
	runId: number,
	target: Target,
	legacyDoc: Y.Doc
): void {
	const { doc: shardDoc, shardId } = resolveWorkspaceContext({
		workspaceId,
		shardId: target.legacyId
	});

	if (target.kind === 'document') {
		copyDocumentVerbatim(legacyDoc, shardDoc, target.legacyId);
	} else {
		copyCollectionVerbatim(legacyDoc, shardDoc, target.legacyId);
	}

	const snapshotStore = getSnapshotStore(workspaceId, shardId);
	const state = Y.encodeStateAsUpdate(shardDoc);
	snapshotStore.save(state);
	const checksum = createHash('sha256').update(state).digest('hex');

	const now = Date.now();
	getDb().transaction((tx) => {
		if (target.kind === 'document') {
			tx.insert(catalogDocuments)
				.values({
					id: target.legacyId,
					workspaceId,
					spaceId: defaultSpaceId,
					shardId,
					title: target.meta.title,
					parentDocumentId: target.meta.parentDocumentId,
					order: target.meta.order,
					createdAt: now,
					updatedAt: now
				})
				.onConflictDoUpdate({
					target: [catalogDocuments.workspaceId, catalogDocuments.id],
					set: { shardId, updatedAt: now }
				})
				.run();
		} else {
			tx.insert(catalogCollections)
				.values({
					id: target.legacyId,
					workspaceId,
					spaceId: defaultSpaceId,
					shardId,
					title: target.meta.title,
					createdAt: now,
					updatedAt: now
				})
				.onConflictDoUpdate({
					target: [catalogCollections.workspaceId, catalogCollections.id],
					set: { shardId, updatedAt: now }
				})
				.run();
		}

		tx.insert(recordLocator)
			.values({
				workspaceId,
				recordId: target.legacyId,
				kind: target.kind,
				spaceId: defaultSpaceId,
				shardId,
				createdAt: now
			})
			.onConflictDoUpdate({
				target: [recordLocator.workspaceId, recordLocator.recordId],
				set: { shardId }
			})
			.run();

		tx.insert(migrationTargets)
			.values({
				runId,
				legacyId: target.legacyId,
				kind: target.kind,
				targetShardId: shardId,
				checksum,
				durable: true,
				migratedAt: now
			})
			.onConflictDoUpdate({
				target: [migrationTargets.runId, migrationTargets.legacyId],
				set: { targetShardId: shardId, checksum, durable: true, migratedAt: now }
			})
			.run();
	});
}

export interface MigrateWorkspaceOptions {
	workspaceId?: string;
	dryRun?: boolean;
}

/**
 * Runs (or, with `dryRun`, simulates) the §7 legacy-shard migration for one
 * workspace: relocates every not-yet-migrated legacy Document/Collection into
 * its own per-record shard, reusing the existing `migrationRuns` row if this
 * workspace/version has already been run so re-invocation only processes
 * genuinely new legacy content. A dry run reports what would move without
 * writing anything.
 */
export function migrateWorkspace(options: MigrateWorkspaceOptions = {}): MigrationResult {
	const workspaceId = options.workspaceId ?? DEFAULT_WORKSPACE_ID;
	const dryRun = options.dryRun ?? false;

	// Load the legacy snapshot into an isolated Y.Doc (§7) — never read from
	// or mutate the live resolved default context's doc directly, so a
	// migration run never races a concurrent live write to legacy content.
	const { doc: liveDefaultDoc, defaultSpaceId } = resolveWorkspaceContext({
		workspaceId,
		shardId: DEFAULT_SHARD_ID
	});
	const snapshotStore = getSnapshotStore(workspaceId, DEFAULT_SHARD_ID);
	const persisted = snapshotStore.loadLatest();
	const state = persisted ?? Y.encodeStateAsUpdate(liveDefaultDoc);
	const legacyDoc = new Y.Doc();
	Y.applyUpdate(legacyDoc, state);

	// A dry run never creates a migrationRuns row — it reports against
	// whatever run already exists (if any), or reports every target as
	// migratable when none does yet, without writing anything.
	const existingRun = findExistingRun(workspaceId);
	const run = dryRun
		? (existingRun ?? { id: -1 })
		: (existingRun ?? createRun(workspaceId, legacyDoc));
	const targets = discoverTargets(legacyDoc);

	const targetsMigrated: string[] = [];
	const targetsAlreadyDurable: string[] = [];

	for (const target of targets) {
		if (existingRun && isDurable(existingRun.id, target.legacyId)) {
			targetsAlreadyDurable.push(target.legacyId);
			continue;
		}
		if (dryRun) {
			targetsMigrated.push(target.legacyId);
			continue;
		}
		migrateTarget(workspaceId, defaultSpaceId, run.id, target, legacyDoc);
		targetsMigrated.push(target.legacyId);
	}

	if (!dryRun) {
		getDb()
			.update(migrationRuns)
			.set({ status: 'complete', completedAt: Date.now() })
			.where(eq(migrationRuns.id, run.id))
			.run();
	}

	return { runId: run.id, dryRun, targetsMigrated, targetsAlreadyDurable };
}
