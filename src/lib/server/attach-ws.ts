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
	wss.on('connection', setupWSConnection);

	server.on('upgrade', (request, socket, head) => {
		const { pathname } = new URL(request.url ?? '/', 'http://localhost');
		// The y-websocket client always appends a room name segment
		// (serverUrl + '/' + roomname); Phase 0 serves one shared workspace
		// doc regardless of room, so match by prefix rather than exact path.
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
