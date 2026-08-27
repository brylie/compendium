import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import type { Awareness } from 'y-protocols/awareness';
import { browser } from '$app/environment';

// Browser counterpart to src/lib/server/workspace-store.ts's resolved
// context. Both connect to the same shared workspace room over /ws, so the
// same src/lib/data/* record functions work unmodified against either doc —
// per docs/specifications/architecture.md §2, UI and MCP share one data-access layer.

let doc: Y.Doc | null = null;
let provider: WebsocketProvider | null = null;

function wsUrl(): string {
	const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
	return `${proto}://${window.location.host}/ws`;
}

export function getClientDoc(): Y.Doc {
	if (!browser) throw new Error('getClientDoc() is browser-only');
	if (doc) return doc;
	doc = new Y.Doc();
	provider = new WebsocketProvider(wsUrl(), 'workspace', doc);
	return doc;
}

export function getClientProvider(): WebsocketProvider {
	getClientDoc();
	return provider!;
}

export function getClientAwareness(): Awareness {
	return getClientProvider().awareness;
}
