import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachYjsWebSocket } from './attach-ws';
import { resetWorkspaceStoreForTests, resolveWorkspaceContext } from './workspace-store';
import { resetHoldsForTests } from './holds';
import { createDocument } from '../services/documents';
import { CURRENT_USER } from './current-user';

// Minimal stand-in for `ws`'s WebSocket, matching the one already used in
// yjs-ws-server.test.ts — just enough surface for setupWSConnection to run
// for real once the handshake reaches it.
class FakeSocket extends EventEmitter {
	destroy = vi.fn();
}

class MockWebSocket extends EventEmitter {
	readyState = 1;
	OPEN = 1;
	binaryType = '';
	send(_data: unknown, cb?: (err?: Error) => void): void {
		cb?.();
	}
	close(): void {}
	ping(): void {}
}

describe('attachYjsWebSocket: upgrade routing', () => {
	beforeEach(() => {
		resetWorkspaceStoreForTests();
		resetHoldsForTests();
	});

	afterEach(() => {
		resetWorkspaceStoreForTests();
	});

	// Regression test for the production entry point (server.ts), where
	// attachYjsWebSocket is the *only* 'upgrade' listener on a bare
	// http.Server (no Vite in the mix). A real http.Server is used here —
	// rather than a plain EventEmitter — because the behavior under test
	// (server.listenerCount('upgrade') === 1) is specifically about a real
	// Server's listener bookkeeping, not just generic event dispatch.
	it('destroys the socket for an unmatched path when it is the sole "upgrade" listener', () => {
		const server = createServer();
		const wss = attachYjsWebSocket(server, '/ws');
		const handleUpgradeSpy = vi.spyOn(wss, 'handleUpgrade').mockImplementation(() => {});

		const socket = new FakeSocket();
		(server as unknown as EventEmitter).emit(
			'upgrade',
			{ url: '/unrelated' },
			socket,
			Buffer.alloc(0)
		);

		expect(socket.destroy).toHaveBeenCalled();
		expect(handleUpgradeSpy).not.toHaveBeenCalled();
		wss.close();
		server.close();
	});

	// Regression test for a bug where this listener destroyed sockets it
	// didn't own: Vite's dev server attaches its own 'upgrade' listener for
	// its HMR websocket on the same shared httpServer, and Node calls every
	// 'upgrade' listener regardless of what an earlier one already did with
	// the socket. Destroying non-matching-path sockets here tore down
	// connections Vite's listener had just finished upgrading, sending the
	// Vite HMR client into an endless reconnect/reload loop. A real
	// http.Server is used so server.listenerCount('upgrade') genuinely
	// reflects two registered listeners, the same way it does in dev.
	it('does not destroy a socket another upgrade listener on the same server already claimed', () => {
		const server = createServer();
		const socket = new FakeSocket();

		// Stand-in for Vite's own HMR 'upgrade' listener, registered first
		// (as it is in the real server) and completing its own handshake for
		// a path attachYjsWebSocket doesn't own.
		const otherListenerHandled = vi.fn();
		server.on('upgrade', (request) => {
			if (request.url === '/') otherListenerHandled();
		});

		const wss = attachYjsWebSocket(server, '/ws');
		const handleUpgradeSpy = vi.spyOn(wss, 'handleUpgrade').mockImplementation(() => {});

		(server as unknown as EventEmitter).emit('upgrade', { url: '/' }, socket, Buffer.alloc(0));

		expect(otherListenerHandled).toHaveBeenCalledTimes(1);
		expect(socket.destroy).not.toHaveBeenCalled();
		expect(handleUpgradeSpy).not.toHaveBeenCalled();
		wss.close();
		server.close();
	});

	it('hands the upgrade off to the WebSocket server for a matching path, including a room suffix', () => {
		const server = new EventEmitter();
		const wss = attachYjsWebSocket(
			server as unknown as Parameters<typeof attachYjsWebSocket>[0],
			'/ws'
		);
		const handleUpgradeSpy = vi.spyOn(wss, 'handleUpgrade').mockImplementation(() => {});

		const socket = new FakeSocket();
		server.emit('upgrade', { url: '/ws/workspace' }, socket, Buffer.alloc(0));

		expect(socket.destroy).not.toHaveBeenCalled();
		expect(handleUpgradeSpy).toHaveBeenCalledTimes(1);
		wss.close();
	});

	it('completes the handshake, running the real connection setup once handleUpgrade calls back', () => {
		const server = new EventEmitter();
		const wss = attachYjsWebSocket(
			server as unknown as Parameters<typeof attachYjsWebSocket>[0],
			'/ws'
		);
		const ws = new MockWebSocket();
		vi.spyOn(wss, 'handleUpgrade').mockImplementation((req, _socket, _head, cb) => {
			cb(ws as never, req);
		});

		server.emit('upgrade', { url: '/ws' }, new FakeSocket(), Buffer.alloc(0));

		// setupWSConnection ran for real and wired the doc/awareness listeners.
		expect(ws.listenerCount('message')).toBeGreaterThan(0);
		wss.close();
	});

	it('derives a shardId selector from a "shard-<id>" room, connecting to that shard\'s own context (#120)', () => {
		// Must be a real, catalog-tracked Document/Collection id — #111/#138
		// hardened setupWSConnection to reject an unknown/fabricated shard id
		// (see the rejection test below) rather than lazily creating an empty
		// doc for it, so a fabricated id like the old 'abc123' no longer
		// connects at all.
		const document = createDocument(CURRENT_USER, { title: 'Shard Room Doc' });

		const server = new EventEmitter();
		const wss = attachYjsWebSocket(
			server as unknown as Parameters<typeof attachYjsWebSocket>[0],
			'/ws'
		);
		const ws = new MockWebSocket();
		vi.spyOn(wss, 'handleUpgrade').mockImplementation((req, _socket, _head, cb) => {
			cb(ws as never, req);
		});

		server.emit('upgrade', { url: `/ws/shard-${document.id}` }, new FakeSocket(), Buffer.alloc(0));

		const shardContext = resolveWorkspaceContext({ shardId: document.id });
		expect(shardContext.connections.has(ws)).toBe(true);
		const defaultContext = resolveWorkspaceContext();
		expect(defaultContext.connections.has(ws)).toBe(false);
		wss.close();
	});

	it('closes the connection for an unknown/fabricated shard id instead of creating an empty doc (#111/#138)', () => {
		const server = new EventEmitter();
		const wss = attachYjsWebSocket(
			server as unknown as Parameters<typeof attachYjsWebSocket>[0],
			'/ws'
		);
		const ws = new MockWebSocket();
		const closeSpy = vi.spyOn(ws, 'close');
		vi.spyOn(wss, 'handleUpgrade').mockImplementation((req, _socket, _head, cb) => {
			cb(ws as never, req);
		});

		server.emit(
			'upgrade',
			{ url: '/ws/shard-never-created-this-id' },
			new FakeSocket(),
			Buffer.alloc(0)
		);

		expect(closeSpy).toHaveBeenCalledWith(4404, 'Unknown shard');
		// No context was created for the fabricated id — resolving it now
		// would be a *fresh* resolution, not proof one already existed, but
		// the connection itself never got wired up (no message listener).
		expect(ws.listenerCount('message')).toBe(0);
		wss.close();
	});

	it("connects a \"shard-default\" room even though no locator row's recordId equals 'default' (#111/#138 regression)", () => {
		// A pre-migration Document/Collection's own shard id is
		// DEFAULT_SHARD_ID, not its own id (GET /api/{documents,collections}/
		// [id]/shard's own contract) — the shardId a real client sends here is
		// never a record id to look up in the locator by recordId. Regression
		// guard for a real bug: an earlier version of this check queried the
		// locator by recordId === shardId, which would have rejected every
		// legitimate connection to un-migrated content.
		const server = new EventEmitter();
		const wss = attachYjsWebSocket(
			server as unknown as Parameters<typeof attachYjsWebSocket>[0],
			'/ws'
		);
		const ws = new MockWebSocket();
		const closeSpy = vi.spyOn(ws, 'close');
		vi.spyOn(wss, 'handleUpgrade').mockImplementation((req, _socket, _head, cb) => {
			cb(ws as never, req);
		});

		server.emit('upgrade', { url: '/ws/shard-default' }, new FakeSocket(), Buffer.alloc(0));

		expect(closeSpy).not.toHaveBeenCalled();
		expect(resolveWorkspaceContext().connections.has(ws)).toBe(true);
		ws.emit('close');
		wss.close();
	});

	it('the "workspace" room still resolves to the default context, unchanged', () => {
		const server = new EventEmitter();
		const wss = attachYjsWebSocket(
			server as unknown as Parameters<typeof attachYjsWebSocket>[0],
			'/ws'
		);
		const ws = new MockWebSocket();
		vi.spyOn(wss, 'handleUpgrade').mockImplementation((req, _socket, _head, cb) => {
			cb(ws as never, req);
		});

		server.emit('upgrade', { url: '/ws/workspace' }, new FakeSocket(), Buffer.alloc(0));

		expect(resolveWorkspaceContext().connections.has(ws)).toBe(true);
		wss.close();
	});
});
