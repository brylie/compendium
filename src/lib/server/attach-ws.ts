import type { Server } from 'node:http';
import type { Http2SecureServer } from 'node:http2';
import { WebSocketServer } from 'ws';
import { setupWSConnection } from './yjs-ws-server.js';

/**
 * Attaches the Yjs sync/awareness WebSocket endpoint to a raw Node HTTP server.
 * Accepts Vite dev/preview's httpServer (which may be an HTTP/2 secure server)
 * as well as the plain http.Server used by the production entry point.
 */
export function attachYjsWebSocket(
	server: Server | Http2SecureServer,
	path = '/ws'
): WebSocketServer {
	const wss = new WebSocketServer({ noServer: true });
	// No selector passed through here — see the room-name comment below for why.
	wss.on('connection', (ws) => setupWSConnection(ws));

	server.on('upgrade', (request, socket, head) => {
		const { pathname } = new URL(request.url ?? '/', 'http://localhost');
		// The y-websocket client always appends a room name segment
		// (serverUrl + '/' + roomname), matched here by prefix only to tell
		// "is this our endpoint" from "is this Vite HMR's" apart. That segment is
		// deliberately *not* forwarded into setupWSConnection as a workspace
		// selector: Phase 0 has no auth to validate a client-supplied room name
		// against, so every connection binds to the explicit trusted-local
		// default context regardless of what room it asked for (issue #30) — a
		// client-controlled value is a selector, never authority, until #13 adds
		// the auth layer that could make one trustworthy.
		if (pathname !== path && !pathname.startsWith(path + '/')) {
			// On a server shared with another 'upgrade' listener (notably
			// Vite's own HMR websocket, registered on this same httpServer in
			// dev), leave the socket alone: Node delivers 'upgrade' to every
			// listener regardless of whether an earlier one already
			// completed the handshake, so destroying it here tore down
			// connections that listener had already upgraded, sending the
			// Vite HMR client into a reconnect/reload loop. But when we're
			// the *only* 'upgrade' listener — true in the production entry
			// point (server.ts), which attaches us to a bare http.Server —
			// there is no other owner to defer to, and a genuinely unmatched
			// upgrade request should be rejected rather than left open on
			// the socket indefinitely.
			if (server.listenerCount('upgrade') === 1) socket.destroy();
			return;
		}
		wss.handleUpgrade(request, socket, head, (ws) => {
			wss.emit('connection', ws, request);
		});
	});

	return wss;
}
