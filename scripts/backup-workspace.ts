#!/usr/bin/env tsx
// CLI entry point for a manual, one-off backup (#19). The recurring
// scheduled backup (wireBackupScheduleOnce, wired from server.ts) runs the
// same underlying runBackup() — this script exists for an operator who
// wants a backup right now (e.g. immediately before an upgrade) without
// waiting for BACKUP_INTERVAL_MS. See src/lib/server/backup.ts and
// docs/specifications/backup-recovery.md.
//
// Usage:
//   npm run db:backup

import { runBackup } from '../src/lib/server/backup.js';
import { closeDb } from '../src/lib/server/store.js';

function main(): void {
	console.log('Running backup...');
	const result = runBackup();
	console.log(`Backup written to ${result.filePath} (${result.sizeBytes} bytes)`);
	closeDb();
}

main();
