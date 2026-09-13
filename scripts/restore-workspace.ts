#!/usr/bin/env tsx
// CLI entry point for restoring a backup produced by runBackup() (#19). See
// docs/specifications/backup-recovery.md for the documented, tested restore
// procedure this implements.
//
// Usage:
//   npm run db:restore -- --file=.data/backups/compendium-default-....db
//   npm run db:restore -- --file=<path> --target=<path>   # defaults to DATABASE_URL
//
// The server must not be running against the target database while this
// runs: restoring while the live process holds it open will either fail or
// leave the process with a stale in-memory view of the file this script
// just replaced. Stop the server first, restore, then start it again.

import { restoreFrom } from '../src/lib/server/backup.js';

function parseArgs(argv: string[]): { file: string; target: string } {
	let file: string | undefined;
	let target = process.env.DATABASE_URL ?? '.data/compendium.db';
	for (const arg of argv) {
		if (arg.startsWith('--file=')) {
			file = arg.slice('--file='.length);
		} else if (arg.startsWith('--target=')) {
			target = arg.slice('--target='.length);
		} else {
			throw new Error(
				`Unrecognized argument: ${arg}. Expected --file=<path> and/or --target=<path>.`
			);
		}
	}
	if (!file)
		throw new Error('Missing required argument: --file=<path to a backup produced by runBackup>');
	return { file, target };
}

function main(): void {
	const { file, target } = parseArgs(process.argv.slice(2));

	console.log(`Restoring ${file} -> ${target}...`);
	restoreFrom(file, target);
	console.log(
		`Restored. Any existing file at ${target} was preserved as ${target}.pre-restore-<timestamp>.`
	);
	console.log('Start the server to verify the restored data.');
}

main();
