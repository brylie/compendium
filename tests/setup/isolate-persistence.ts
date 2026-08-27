import { afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '$lib/server/store';
import { resetWorkspaceStoreForTests } from '$lib/server/workspace-store';

// Every test in this project touches the real getDb()/resolveWorkspaceContext()
// singletons somewhere in the call chain (directly or via a service function). Without
// this, DATABASE_URL defaults to .data/compendium.db — the real dev
// workspace database — and test runs silently write real audit log entries
// and Yjs snapshots into it. This applies to every test file automatically
// so isolation doesn't depend on each file remembering to set it up itself
// (see tests/e2e/harness.ts for the equivalent Tier A/B isolation).
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'test-'));
	process.env.DATABASE_URL = join(dir, 'test.db');
});

afterEach(() => {
	closeDb();
	resetWorkspaceStoreForTests();
	delete process.env.DATABASE_URL;
	rmSync(dir, { recursive: true, force: true });
});
