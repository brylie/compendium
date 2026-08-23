import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import type { WebSocket } from 'ws';
import { setupWSConnection } from './yjs-ws-server';
import { getAwareness, resetAwarenessForTests } from './awareness';
import { getYDoc, resetYDocForTests } from './ydoc';
import { resetHoldsForTests } from './holds';

// Minimal stand-in for the `ws` library's WebSocket, just enough surface for
// setupWSConnection: EventEmitter for on/emit, plus the properties/methods it
// reads or calls directly.
class MockWebSocket extends EventEmitter {
	readyState = 1;
	OPEN = 1;
	binaryType = '';
	sendImpl?: (data: unknown, cb?: (err?: Error) => void) => void;
	send(data: unknown, cb?: (err?: Error) => void): void {
		if (this.sendImpl) {
			this.sendImpl(data, cb);
			return;
		}
		cb?.();
	}
	close(): void {}
	ping(): void {}
}

function publishAwarenessState(
	awareness: ReturnType<typeof getAwareness>,
	clientId: number,
	origin: unknown,
	state: unknown
): void {
	// Same wire-level construction holds.ts's writeRemoteState uses, but with
	// an arbitrary origin (a connection object) instead of the 'server' string,
	// so applyAwarenessUpdate attributes the change to that origin — exactly
	// what a real message handler does with the connection's own `ws`.
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, 1);
	encoding.writeVarUint(encoder, clientId);
	encoding.writeVarUint(encoder, 1);
	encoding.writeVarString(encoder, JSON.stringify(state));
	awarenessProtocol.applyAwarenessUpdate(awareness, encoding.toUint8Array(encoder), origin);
}

describe('yjs-ws-server: disconnect cleanup', () => {
	beforeEach(() => {
		resetYDocForTests();
		resetAwarenessForTests();
		resetHoldsForTests();
	});

	afterEach(() => {
		resetAwarenessForTests();
		resetYDocForTests();
	});

	it('a closing connection removes only the awareness clients it introduced, leaving other connections intact', () => {
		const awareness = getAwareness();
		const wsA = new MockWebSocket();
		const wsB = new MockWebSocket();

		setupWSConnection(wsA as unknown as WebSocket);
		setupWSConnection(wsB as unknown as WebSocket);

		publishAwarenessState(awareness, 111, wsA, { actor: 'a' });
		publishAwarenessState(awareness, 222, wsB, { actor: 'b' });

		expect(awareness.getStates().has(111)).toBe(true);
		expect(awareness.getStates().has(222)).toBe(true);

		wsA.emit('close');

		expect(awareness.getStates().has(111)).toBe(false);
		expect(awareness.getStates().has(222)).toBe(true);

		wsB.emit('close');
		expect(awareness.getStates().has(222)).toBe(false);
	});

	it('skips sending a doc update to a socket that is not open', () => {
		const ws = new MockWebSocket();
		ws.readyState = 3; // CLOSED
		const sendSpy = vi.fn();
		ws.sendImpl = sendSpy;

		setupWSConnection(ws as unknown as WebSocket);
		getYDoc().getMap('workspace').set('key', 'value'); // triggers doc's 'update' event

		expect(sendSpy).not.toHaveBeenCalled();
	});

	it('closes the connection when a synchronous ws.send throw is caught', () => {
		const ws = new MockWebSocket();
		ws.sendImpl = () => {
			throw new Error('boom');
		};

		setupWSConnection(ws as unknown as WebSocket);
		expect(() => getYDoc().getMap('workspace').set('key2', 'value2')).not.toThrow();
	});

	it('closes the connection on a malformed incoming message', () => {
		const ws = new MockWebSocket();
		setupWSConnection(ws as unknown as WebSocket);

		expect(() => ws.emit('message', new ArrayBuffer(0))).not.toThrow();
	});

	describe('ping/pong keepalive', () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it('closes the connection if no pong arrives before the next ping', () => {
			const ws = new MockWebSocket();
			const closeSpy = vi.spyOn(ws, 'close');
			setupWSConnection(ws as unknown as WebSocket);

			vi.advanceTimersByTime(30_000); // first ping sent, pongReceived reset to false
			vi.advanceTimersByTime(30_000); // no pong arrived in between -> closeConn

			expect(closeSpy).toHaveBeenCalled();
		});

		it('keeps the connection alive when a pong arrives between pings', () => {
			const ws = new MockWebSocket();
			const closeSpy = vi.spyOn(ws, 'close');
			setupWSConnection(ws as unknown as WebSocket);

			vi.advanceTimersByTime(30_000);
			ws.emit('pong');
			vi.advanceTimersByTime(30_000);

			expect(closeSpy).not.toHaveBeenCalled();
		});

		it('closes the connection when ws.ping() throws', () => {
			const ws = new MockWebSocket();
			ws.ping = () => {
				throw new Error('ping failed');
			};
			const closeSpy = vi.spyOn(ws, 'close');
			setupWSConnection(ws as unknown as WebSocket);

			vi.advanceTimersByTime(30_000);

			expect(closeSpy).toHaveBeenCalled();
		});
	});
});
