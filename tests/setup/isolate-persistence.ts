import { afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '$lib/server/store';
import { resetYDocForTests } from '$lib/server/ydoc';
import { resetAwarenessForTests } from '$lib/server/awareness';

// Every test in this project touches the real getDb()/getYDoc() singletons
// somewhere in the call chain (directly or via a service function). Without
// this, DATABASE_URL defaults to .data/agentspace.db — the real dev
// workspace database — and test runs silently write real audit log entries
// and Yjs snapshots into it. This applies to every test file automatically
// so isolation doesn't depend on each file remembering to set it up itself
// (see tests/e2e/harness.ts for the equivalent Tier A/B isolation).
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'agentspace-test-'));
	process.env.DATABASE_URL = join(dir, 'test.db');
});

afterEach(() => {
	closeDb();
	resetYDocForTests();
	resetAwarenessForTests();
	delete process.env.DATABASE_URL;
	rmSync(dir, { recursive: true, force: true });
});
