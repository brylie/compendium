import type { WebSocket } from 'ws';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import {
	registerConnection,
	resolveWorkspaceContext,
	type WorkspaceSelector
} from './workspace-store.js';
import { getInstanceWorkspaceId } from './instance.js';
import { resolveShardForParent } from './catalog.js';

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
 * creates a Y.Doc for it: `id` must already be a real Document or
 * Collection's own shard, not an unknown/fabricated value — otherwise the
 * connection is closed rather than silently getting a fresh, empty doc. A
 * bare selector (the shared default room) is exempt: it names the
 * workspace's own root context, not a single catalog-tracked resource. Safe
 * against the legitimate "just-created, not-yet-connected" case: locator
 * reservation happens synchronously during createDocument/createCollection,
 * before the client ever receives the new id to connect with.
 */
export function setupWSConnection(ws: WebSocket, selector?: WorkspaceSelector): void {
	if (selector?.shardId) {
		const workspaceId = selector.workspaceId ?? getInstanceWorkspaceId();
		if (!resolveShardForParent(workspaceId, selector.shardId)) {
			ws.close(4004, 'Unknown shard');
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
