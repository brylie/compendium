import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachYjsWebSocket } from './attach-ws';
import { resetYDocForTests } from './ydoc';
import { resetAwarenessForTests } from './awareness';
import { resetHoldsForTests } from './holds';

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
		resetYDocForTests();
		resetAwarenessForTests();
		resetHoldsForTests();
	});

	afterEach(() => {
		resetAwarenessForTests();
		resetYDocForTests();
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
});
