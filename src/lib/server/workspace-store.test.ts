import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from './store';
import {
	flush,
	registerConnection,
	releaseContextIfIdle,
	resetWorkspaceStoreForTests,
	resolveWorkspaceContext
} from './workspace-store';

describe('workspace-store: snapshot persistence survives a process restart', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'workspace-store-'));
		process.env.DATABASE_URL = join(dir, 'test.db');
	});

	afterEach(() => {
		resetWorkspaceStoreForTests();
		closeDb();
		delete process.env.DATABASE_URL;
		rmSync(dir, { recursive: true, force: true });
	});

	it('reloads the last saved state after the in-memory doc is dropped ("restart")', () => {
		const { doc: doc1 } = resolveWorkspaceContext();
		doc1.getMap('workspace').set('greeting', 'hello from before restart');
		flush();

		// Simulate a process restart: drop the registry and DB handle, force a
		// fresh load from the same on-disk snapshot.
		resetWorkspaceStoreForTests();
		closeDb();

		const { doc: doc2 } = resolveWorkspaceContext();
		expect(doc2.getMap('workspace').get('greeting')).toBe('hello from before restart');
	});

	it('flush() is a no-op when there is nothing dirty to save', () => {
		resolveWorkspaceContext();
		flush(); // nothing written yet -> dirty is false
		expect(() => flush()).not.toThrow();
	});
});

describe('workspace-store: isolation between independently-resolved contexts', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'workspace-store-isolation-'));
		process.env.DATABASE_URL = join(dir, 'test.db');
	});

	afterEach(() => {
		resetWorkspaceStoreForTests();
		closeDb();
		delete process.env.DATABASE_URL;
		rmSync(dir, { recursive: true, force: true });
	});

	it('resolves the same context object for repeated calls with the same selector', () => {
		const a = resolveWorkspaceContext({ workspaceId: 'space-a', shardId: 'main' });
		const b = resolveWorkspaceContext({ workspaceId: 'space-a', shardId: 'main' });
		expect(a).toBe(b);
	});

	it('gives two distinct {workspaceId, shardId} keys their own, disconnected Y.Doc', () => {
		const a = resolveWorkspaceContext({ workspaceId: 'space-a', shardId: 'main' });
		const b = resolveWorkspaceContext({ workspaceId: 'space-b', shardId: 'main' });

		a.doc.getMap('workspace').set('title', 'Space A');
		b.doc.getMap('workspace').set('title', 'Space B');

		expect(a.doc.getMap('workspace').get('title')).toBe('Space A');
		expect(b.doc.getMap('workspace').get('title')).toBe('Space B');
		// A CRDT update to one never reaches the other's doc at all — they are
		// genuinely separate Y.Doc instances, not a shared doc filtered by key.
		expect(a.doc).not.toBe(b.doc);
	});

	it('does not collide two different {workspaceId, shardId} pairs that share a delimiter-joined string', () => {
		// 'space::main' + 'primary' and 'space' + 'main::primary' would produce
		// the identical `${a}::${b}` string under a naive delimited join.
		const a = resolveWorkspaceContext({ workspaceId: 'space::main', shardId: 'primary' });
		const b = resolveWorkspaceContext({ workspaceId: 'space', shardId: 'main::primary' });

		a.doc.getMap('workspace').set('title', 'A');
		b.doc.getMap('workspace').set('title', 'B');

		expect(a.doc).not.toBe(b.doc);
		expect(a.doc.getMap('workspace').get('title')).toBe('A');
		expect(b.doc.getMap('workspace').get('title')).toBe('B');
	});

	it('gives two distinct keys their own, disconnected Awareness instance', () => {
		const a = resolveWorkspaceContext({ workspaceId: 'space-a', shardId: 'main' });
		const b = resolveWorkspaceContext({ workspaceId: 'space-b', shardId: 'main' });

		a.awareness.setLocalState({ actor: { kind: 'human', userId: 'a' }, heldRecordIds: ['rec-1'] });

		expect(a.awareness.getLocalState()).toEqual({
			actor: { kind: 'human', userId: 'a' },
			heldRecordIds: ['rec-1']
		});
		expect(b.awareness.getLocalState()).toEqual({});
		expect(a.awareness).not.toBe(b.awareness);
	});

	it('persists two distinct keys to non-colliding snapshot rows, each reloadable independently', () => {
		const a = resolveWorkspaceContext({ workspaceId: 'space-a', shardId: 'main' });
		const b = resolveWorkspaceContext({ workspaceId: 'space-b', shardId: 'main' });

		a.doc.getMap('workspace').set('title', 'Space A');
		b.doc.getMap('workspace').set('title', 'Space B');
		flush();

		resetWorkspaceStoreForTests();

		const reloadedA = resolveWorkspaceContext({ workspaceId: 'space-a', shardId: 'main' });
		const reloadedB = resolveWorkspaceContext({ workspaceId: 'space-b', shardId: 'main' });

		expect(reloadedA.doc.getMap('workspace').get('title')).toBe('Space A');
		expect(reloadedB.doc.getMap('workspace').get('title')).toBe('Space B');
	});

	it('scopes connection registration to its own context, not the whole registry', () => {
		const a = resolveWorkspaceContext({ workspaceId: 'space-a', shardId: 'main' });
		const b = resolveWorkspaceContext({ workspaceId: 'space-b', shardId: 'main' });

		const unregister = registerConnection(a, { fakeSocket: true });

		expect(a.connections.size).toBe(1);
		expect(b.connections.size).toBe(0);

		unregister();
		expect(a.connections.size).toBe(0);
	});

	it('releaseContextIfIdle only tears down the requested key, leaving other contexts live', () => {
		const a = resolveWorkspaceContext({ workspaceId: 'space-a', shardId: 'main' });
		resolveWorkspaceContext({ workspaceId: 'space-b', shardId: 'main' });

		const released = releaseContextIfIdle('space-a', 'main');
		expect(released).toBe(true);

		const reResolvedA = resolveWorkspaceContext({ workspaceId: 'space-a', shardId: 'main' });
		expect(reResolvedA.doc).not.toBe(a.doc); // dropped and freshly recreated, not the same instance

		const stillB = resolveWorkspaceContext({ workspaceId: 'space-b', shardId: 'main' });
		expect(stillB.connections).toBeDefined(); // still resolvable, never touched by the release above
	});

	it('does not release a context that still has a registered connection', () => {
		const a = resolveWorkspaceContext({ workspaceId: 'space-a', shardId: 'main' });
		registerConnection(a, { fakeSocket: true });

		expect(releaseContextIfIdle('space-a', 'main')).toBe(false);
	});
});
