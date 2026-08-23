import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import type { WebSocket } from 'ws';
import { setupWSConnection } from './yjs-ws-server';
import { getAwareness, resetAwarenessForTests } from './awareness';
import { resetYDocForTests } from './ydoc';
import { resetHoldsForTests } from './holds';

// Minimal stand-in for the `ws` library's WebSocket, just enough surface for
// setupWSConnection: EventEmitter for on/emit, plus the properties/methods it
// reads or calls directly.
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
});
