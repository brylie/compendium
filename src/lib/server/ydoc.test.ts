import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from './store';
import { flush, getYDoc, resetYDocForTests } from './ydoc';

describe('ydoc: snapshot persistence survives a process restart', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'agentspace-ydoc-'));
		process.env.DATABASE_URL = join(dir, 'test.db');
	});

	afterEach(() => {
		resetYDocForTests();
		closeDb();
		delete process.env.DATABASE_URL;
		rmSync(dir, { recursive: true, force: true });
	});

	it('reloads the last saved state after the in-memory doc is dropped ("restart")', () => {
		const doc1 = getYDoc();
		doc1.getMap('workspace').set('greeting', 'hello from before restart');
		flush();

		// Simulate a process restart: drop the singleton and DB handle, force a
		// fresh load from the same on-disk snapshot.
		resetYDocForTests();
		closeDb();

		const doc2 = getYDoc();
		expect(doc2.getMap('workspace').get('greeting')).toBe('hello from before restart');
	});
});
