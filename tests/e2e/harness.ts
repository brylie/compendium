import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createAgentSpaceMcpServer } from '$lib/mcp/server';
import { attachYjsWebSocket } from '$lib/server/attach-ws';
import { createToken, type AccessToken } from '$lib/mcp/tokens';
import { closeDb } from '$lib/server/store';
import { resetYDocForTests } from '$lib/server/ydoc';
import { resetAwarenessForTests } from '$lib/server/awareness';

export interface TestHarness {
	port: number;
	httpUrl: string;
	wsUrl: string;
	tempDir: string;
	createToken: (input: {
		clientLabel: string;
		allowedDocumentIds: string[];
		allowedCollectionIds: string[];
	}) => { token: string; record: AccessToken };
	getMcpClient: (token: string) => Promise<Client>;
	getYjsClient: () => {
		doc: Y.Doc;
		provider: WebsocketProvider;
		awareness: WebsocketProvider['awareness'];
		disconnect: () => void;
	};
	waitForCondition: (
		fn: () => boolean | Promise<boolean>,
		options?: { timeoutMs?: number; intervalMs?: number }
	) => Promise<void>;
	cleanup: () => Promise<void>;
}

async function nodeRequestToWebRequest(
	req: import('node:http').IncomingMessage,
	baseUrl: string
): Promise<Request> {
	const url = new URL(req.url ?? '/', baseUrl);
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const v of value) headers.append(key, v);
		} else {
			headers.set(key, value);
		}
	}
	const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
	let body: Buffer | undefined;
	if (hasBody) {
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
		}
		body = Buffer.concat(chunks);
	}
	return new Request(url, {
		method: req.method,
		headers,
		body: body ? (new Uint8Array(body) as unknown as BodyInit) : undefined
	});
}

export async function createTestHarness(): Promise<TestHarness> {
	const tempDir = mkdtempSync(join(tmpdir(), 'agentspace-e2e-'));
	const dbPath = join(tempDir, 'test.db');
	process.env.DATABASE_URL = dbPath;

	// Reset state
	closeDb();
	resetYDocForTests();
	resetAwarenessForTests();

	let port = 0;
	const mcpClients: Client[] = [];
	const yjsProviders: WebsocketProvider[] = [];

	let appHandler: ((req: IncomingMessage, res: ServerResponse, next: () => void) => void) | null =
		null;
	try {
		const buildPath = join(process.cwd(), 'build/handler.js');
		const dynamicImport = new Function('p', 'return import(p)');
		const mod = (await dynamicImport(buildPath)) as {
			handler?: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
		};
		appHandler = mod.handler ?? null;
	} catch {
		// Build directory not present in unit test mode
	}

	const server: Server = createServer(async (req, res) => {
		try {
			if (req.url?.startsWith('/mcp')) {
				const webReq = await nodeRequestToWebRequest(req, `http://localhost:${port}`);
				const auth = webReq.headers.get('authorization');
				const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : undefined;

				const mcpServer = createAgentSpaceMcpServer();
				const transport = new WebStandardStreamableHTTPServerTransport({
					sessionIdGenerator: undefined
				});
				await mcpServer.connect(transport);
				const webRes = await transport.handleRequest(webReq, {
					authInfo: token ? { token, clientId: 'local', scopes: [] } : undefined
				});

				res.statusCode = webRes.status;
				webRes.headers.forEach((val, key) => {
					res.setHeader(key, val);
				});
				if (webRes.body) {
					const reader = webRes.body.getReader();
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						res.write(value);
					}
				}
				res.end();
				return;
			}

			if (appHandler) {
				appHandler(req, res, () => {
					res.statusCode = 404;
					res.end('Not found');
				});
				return;
			}

			res.statusCode = 404;
			res.end('Not found');
		} catch (err) {
			res.statusCode = 500;
			res.end(String(err));
		}
	});

	const wss = attachYjsWebSocket(server, '/ws');

	await new Promise<void>((resolve) => {
		server.listen(0, () => {
			const addr = server.address();
			if (addr && typeof addr === 'object') {
				port = addr.port;
			}
			resolve();
		});
	});

	const httpUrl = `http://localhost:${port}`;
	const wsUrl = `ws://localhost:${port}/ws`;

	async function getMcpClient(token: string): Promise<Client> {
		const transport = new StreamableHTTPClientTransport(new URL('/mcp', httpUrl), {
			requestInit: {
				headers: {
					Authorization: `Bearer ${token}`
				}
			}
		});
		const client = new Client({ name: 'test-mcp-client', version: '1.0.0' });
		await client.connect(transport);
		mcpClients.push(client);
		return client;
	}

	function getYjsClient(): {
		doc: Y.Doc;
		provider: WebsocketProvider;
		awareness: WebsocketProvider['awareness'];
		disconnect: () => void;
	} {
		const doc = new Y.Doc();
		const provider = new WebsocketProvider(wsUrl, 'workspace', doc, {
			WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket
		});
		yjsProviders.push(provider);
		return {
			doc,
			provider,
			awareness: provider.awareness,
			disconnect: () => {
				provider.destroy();
				doc.destroy();
			}
		};
	}

	async function waitForCondition(
		fn: () => boolean | Promise<boolean>,
		options: { timeoutMs?: number; intervalMs?: number } = {}
	): Promise<void> {
		const timeout = options.timeoutMs ?? 2000;
		const interval = options.intervalMs ?? 25;
		const start = Date.now();

		while (Date.now() - start < timeout) {
			if (await fn()) return;
			await new Promise((r) => setTimeout(r, interval));
		}
		throw new Error(`Condition not met within ${timeout}ms`);
	}

	async function cleanup(): Promise<void> {
		for (const p of yjsProviders) {
			try {
				p.destroy();
			} catch {
				// ignore
			}
		}
		for (const c of mcpClients) {
			try {
				await c.close();
			} catch {
				// ignore
			}
		}
		for (const client of wss.clients) {
			try {
				client.terminate();
			} catch {
				// ignore
			}
		}

		await new Promise<void>((resolve) => {
			server.closeAllConnections?.();
			wss.close(() => {
				server.close(() => resolve());
			});
		});

		closeDb();
		resetYDocForTests();
		resetAwarenessForTests();

		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}

	return {
		port,
		httpUrl,
		wsUrl,
		tempDir,
		createToken,
		getMcpClient,
		getYjsClient,
		waitForCondition,
		cleanup
	};
}
