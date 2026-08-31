import type { Server } from 'node:http';
import type { Http2SecureServer } from 'node:http2';
import { WebSocketServer } from 'ws';
import { setupWSConnection } from './yjs-ws-server.js';
import type { WorkspaceSelector } from './workspace-store.js';

const SHARD_ROOM_PREFIX = 'shard-';

/**
 * Turns the room-name path segment the y-websocket client appended
 * (serverUrl + '/' + roomname) into a WorkspaceSelector. `'workspace'` (or no
 * segment at all) is the existing shared room — Documents, unsharded — and
 * resolves to no selector, exactly as before. `'shard-<id>'` names one
 * Document or Collection's own shard; the client always obtains `<id>` from
 * the server first (GET /api/{documents,collections}/[id]/shard), never
 * assumes it equals the parent id. This selector is still just a hint, not
 * authority — but `setupWSConnection` (yjs-ws-server.ts) now verifies `<id>`
 * against the catalog's own record locator before accepting the connection
 * (#111/#138), so an unknown/fabricated id gets the connection closed
 * instead of silently resolving to a fresh, empty Y.Doc.
 */
function selectorFromRoom(room: string): WorkspaceSelector | undefined {
	if (room.startsWith(SHARD_ROOM_PREFIX)) {
		return { shardId: room.slice(SHARD_ROOM_PREFIX.length) };
	}
	return undefined;
}

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
	wss.on('connection', (ws, request) => {
		const { pathname } = new URL(request.url ?? '/', 'http://localhost');
		const room = pathname === path ? '' : pathname.slice(path.length + 1);
		setupWSConnection(ws, selectorFromRoom(room));
	});

	server.on('upgrade', (request, socket, head) => {
		const { pathname } = new URL(request.url ?? '/', 'http://localhost');
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
