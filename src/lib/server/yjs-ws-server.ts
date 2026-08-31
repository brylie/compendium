import type { WebSocket } from 'ws';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import {
	DEFAULT_SHARD_ID,
	registerConnection,
	resolveWorkspaceContext,
	type WorkspaceSelector
} from './workspace-store.js';
import { getInstanceWorkspaceId } from './instance.js';
import { isKnownShard } from './catalog.js';

// y-websocket's npm package ships the browser client only as of v3 — the
// server side (formerly bin/utils.js) is reimplemented here against the same
// wire protocol (sync=0, awareness=1), so the existing y-websocket client
// works against it unmodified.

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const PING_INTERVAL_MS = 30_000;

/**
 * `selector` carries whatever workspace/shard hint attach-ws.ts parsed out of
 * the connection's room path — non-authoritative in Phase 0 (see
 * workspace-store.ts), but threaded through here rather than dropped so the
 * boundary that resolves context is this call, not an implicit global.
 *
 * A `shardId` selector (a `shard-<id>` room) is verified against the
 * catalog's own record locator (#111/#138) before anything resolves or
 * creates a Y.Doc for it: `id` must already be a real shard *some* Document
 * or Collection was actually assigned to (`catalog.ts`'s `isKnownShard`,
 * checked by `recordLocator.shardId` — not by treating `id` as a record id
 * to look up, since a pre-migration Document/Collection's own shard id is
 * `DEFAULT_SHARD_ID`, not its own id; see GET /api/{documents,collections}/
 * [id]/shard). `DEFAULT_SHARD_ID` itself is always exempt from this check —
 * it's the workspace's own shared/legacy shard, not a single catalog-tracked
 * resource, the same way a bare (no `shardId`) selector already is. An
 * unknown/fabricated id gets the connection closed rather than silently
 * resolving to a fresh, empty doc. Safe against the legitimate
 * "just-created, not-yet-connected" case: locator reservation happens
 * synchronously during createDocument/createCollection, before the client
 * ever receives the new id to connect with.
 *
 * The rejection close code is 4404 (not the more obvious 4004): y-websocket's
 * WebsocketProvider only stops reconnecting on codes in the 4400-4499 range
 * (its own defaultShouldReconnect) — a code outside that range gets retried
 * forever, which would make a real client hammer the server indefinitely
 * over a shard that will never become known.
 */
export function setupWSConnection(ws: WebSocket, selector?: WorkspaceSelector): void {
	if (selector?.shardId && selector.shardId !== DEFAULT_SHARD_ID) {
		const workspaceId = selector.workspaceId ?? getInstanceWorkspaceId();
		if (!isKnownShard(workspaceId, selector.shardId)) {
			// 4404, not 4004: y-websocket's WebsocketProvider only treats close
			// codes in the 4400-4499 range as permanent (its own
			// defaultShouldReconnect) — anything outside it gets retried
			// indefinitely, which would have a real client hammer the server
			// forever reconnecting to a shard that will never become known.
			ws.close(4404, 'Unknown shard');
			return;
		}
	}

	const context = resolveWorkspaceContext(selector);
	const { doc, awareness } = context;
	const unregisterConnection = registerConnection(context, ws);
	ws.binaryType = 'arraybuffer';

	const ownedClientIds = new Set<number>();
	let closed = false;
	let pongReceived = true;

	const send = (encoder: encoding.Encoder): void => {
		if (closed || ws.readyState !== ws.OPEN) return;
		try {
			ws.send(encoding.toUint8Array(encoder), (err?: Error) => {
				if (err) closeConn();
			});
		} catch {
			closeConn();
		}
	};

	const docUpdateHandler = (update: Uint8Array): void => {
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MESSAGE_SYNC);
		syncProtocol.writeUpdate(encoder, update);
		send(encoder);
	};

	const awarenessUpdateHandler = (
		{
			added,
			updated,
			removed
		}: {
			added: number[];
			updated: number[];
			removed: number[];
		},
		origin: unknown
	): void => {
		if (origin === ws) {
			for (const id of added) ownedClientIds.add(id);
		}
		for (const id of removed) ownedClientIds.delete(id);
		const changed = added.concat(updated, removed);
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
		encoding.writeVarUint8Array(
			encoder,
			awarenessProtocol.encodeAwarenessUpdate(awareness, changed)
		);
		send(encoder);
	};

	const closeConn = (): void => {
		if (closed) return;
		closed = true;
		if (ownedClientIds.size > 0) {
			awarenessProtocol.removeAwarenessStates(awareness, Array.from(ownedClientIds), 'ws-closed');
		}
		doc.off('update', docUpdateHandler);
		awareness.off('update', awarenessUpdateHandler);
		unregisterConnection();
		clearInterval(pingInterval);
		try {
			ws.close();
		} catch {
			// already closed
		}
	};

	doc.on('update', docUpdateHandler);
	awareness.on('update', awarenessUpdateHandler);

	ws.on('message', (data: ArrayBuffer) => {
		try {
			const decoder = decoding.createDecoder(new Uint8Array(data));
			const messageType = decoding.readVarUint(decoder);
			switch (messageType) {
				case MESSAGE_SYNC: {
					const encoder = encoding.createEncoder();
					encoding.writeVarUint(encoder, MESSAGE_SYNC);
					syncProtocol.readSyncMessage(decoder, encoder, doc, ws);
					if (encoding.length(encoder) > 1) send(encoder);
					break;
				}
				case MESSAGE_AWARENESS: {
					awarenessProtocol.applyAwarenessUpdate(
						awareness,
						decoding.readVarUint8Array(decoder),
						ws
					);
					break;
				}
			}
		} catch (err) {
			console.error('[yjs-ws] malformed message, closing connection', err);
			closeConn();
		}
	});

	ws.on('close', closeConn);
	ws.on('error', closeConn);
	ws.on('pong', () => {
		pongReceived = true;
	});

	const pingInterval = setInterval(() => {
		if (!pongReceived) {
			closeConn();
			return;
		}
		pongReceived = false;
		try {
			ws.ping();
		} catch {
			closeConn();
		}
	}, PING_INTERVAL_MS);

	// Initial handshake: sync step 1 (our state vector), then the full current
	// awareness state so a newly connected client sees who/what is already here.
	{
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MESSAGE_SYNC);
		syncProtocol.writeSyncStep1(encoder, doc);
		send(encoder);
	}
	const states = awareness.getStates();
	if (states.size > 0) {
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
		encoding.writeVarUint8Array(
			encoder,
			awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(states.keys()))
		);
		send(encoder);
	}
}
