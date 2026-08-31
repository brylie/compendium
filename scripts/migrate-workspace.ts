#!/usr/bin/env tsx
// CLI entry point for #114/#132's workspace migration: moves legacy content
// (created before #113's catalog/shard system existed) into its own real
// per-record shard. See src/lib/server/migration.ts for the actual
// implementation and docs/specifications/workspace-sharding.md §7 for the
// spec this follows.
//
// Usage:
//   npm run migrate:workspace                                   # migrate DEFAULT_WORKSPACE_ID
//   npm run migrate:workspace -- --dry-run                       # report only, no writes
//   npm run migrate:workspace -- --workspace-id=my-workspace     # target a specific workspace
//
// Not a vitest project (unlike npm run benchmark:workspace): this is a real,
// deliberately one-shot mutating operation meant to run against production
// data, not a repeatable read-only measurement — a different operational
// shape than the benchmark suite, so it gets its own convention rather than
// reusing that one.

import { migrateWorkspace } from '../src/lib/server/migration.js';
import { closeDb } from '../src/lib/server/store.js';

function parseArgs(argv: string[]): { dryRun: boolean; workspaceId?: string } {
	let dryRun = false;
	let workspaceId: string | undefined;
	for (const arg of argv) {
		if (arg === '--dry-run') {
			dryRun = true;
		} else if (arg.startsWith('--workspace-id=')) {
			workspaceId = arg.slice('--workspace-id='.length);
		} else {
			throw new Error(
				`Unrecognized argument: ${arg}. Expected --dry-run and/or --workspace-id=<id>.`
			);
		}
	}
	return { dryRun, workspaceId };
}

function main(): void {
	const { dryRun, workspaceId } = parseArgs(process.argv.slice(2));

	console.log(
		`Migrating workspace ${workspaceId ?? '(default)'}${dryRun ? ' [dry run — no writes]' : ''}...`
	);

	const result = migrateWorkspace({ workspaceId, dryRun });

	console.log(`Run id: ${result.runId}`);
	console.log(
		`${dryRun ? 'Would migrate' : 'Migrated'} ${result.targetsMigrated.length} target(s): ${result.targetsMigrated.join(', ') || '(none)'}`
	);
	console.log(
		`Already durable (skipped): ${result.targetsAlreadyDurable.length} target(s): ${result.targetsAlreadyDurable.join(', ') || '(none)'}`
	);

	closeDb();
}

main();
