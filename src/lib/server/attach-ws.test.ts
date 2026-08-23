import { EventEmitter } from 'node:events';
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

	it('destroys the socket for an upgrade request outside the configured path', () => {
		const server = new EventEmitter();
		const wss = attachYjsWebSocket(
			server as unknown as Parameters<typeof attachYjsWebSocket>[0],
			'/ws'
		);
		const handleUpgradeSpy = vi.spyOn(wss, 'handleUpgrade').mockImplementation(() => {});

		const socket = new FakeSocket();
		server.emit('upgrade', { url: '/unrelated' }, socket, Buffer.alloc(0));

		expect(socket.destroy).toHaveBeenCalled();
		expect(handleUpgradeSpy).not.toHaveBeenCalled();
		wss.close();
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
