import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { GET, POST, DELETE } from './+server';
import { createDocument } from '$lib/data/records';
import { createToken } from '$lib/mcp/tokens';
import { getYDoc } from '$lib/server/ydoc';

// Mirrors tests/e2e/harness.ts's node-request/web-request bridge, but points
// at this route's own exported handlers rather than reimplementing MCP
// server wiring, so this test exercises extractBearerToken/handle() for real.
async function nodeRequestToWebRequest(req: IncomingMessage, baseUrl: string): Promise<Request> {
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
		for await (const chunk of req)
			chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
		body = Buffer.concat(chunks);
	}
	return new Request(url, {
		method: req.method,
		headers,
		body: body ? (new Uint8Array(body) as unknown as BodyInit) : undefined
	});
}

describe('routes/mcp: HTTP transport wiring and bearer-token extraction', () => {
	let server: Server;
	let baseUrl: string;

	beforeEach(async () => {
		server = createServer((req: IncomingMessage, res: ServerResponse) => {
			void (async () => {
				const request = await nodeRequestToWebRequest(req, 'http://localhost');
				const response =
					req.method === 'POST'
						? await POST({ request } as Parameters<typeof POST>[0])
						: req.method === 'DELETE'
							? await DELETE({ request } as Parameters<typeof DELETE>[0])
							: await GET({ request } as Parameters<typeof GET>[0]);

				res.statusCode = response.status;
				response.headers.forEach((value, key) => res.setHeader(key, value));
				if (response.body) {
					const reader = response.body.getReader();
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						res.write(value);
					}
				}
				res.end();
			})();
		});
		await new Promise<void>((resolve) => server.listen(0, resolve));
		const address = server.address();
		const port = address && typeof address === 'object' ? address.port : 0;
		baseUrl = `http://localhost:${port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it('serves an authenticated tool call end-to-end over the real MCP HTTP transport', async () => {
		const doc = getYDoc();
		const docMeta = createDocument(doc, { title: 'Routed Doc' });
		const { token } = createToken({
			clientLabel: 'Route Test Client',
			allowedDocumentIds: [docMeta.id],
			allowedCollectionIds: []
		});

		const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
			requestInit: { headers: { Authorization: `Bearer ${token}` } }
		});
		const client = new Client({ name: 'route-test', version: '1.0.0' });
		await client.connect(transport);

		const result = (await client.callTool({
			name: 'get_document',
			arguments: { documentId: docMeta.id }
		})) as { isError?: boolean };
		expect(result.isError).toBeFalsy();

		await client.close();
	});

	it('rejects a tool call carrying no bearer token', async () => {
		const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl));
		const client = new Client({ name: 'route-test-unauth', version: '1.0.0' });
		await client.connect(transport);

		const result = (await client.callTool({ name: 'list_documents', arguments: {} })) as {
			isError?: boolean;
		};
		expect(result.isError).toBe(true);

		await client.close();
	});

	it('GET responds without an active session', async () => {
		const response = await GET({
			request: new Request(`${baseUrl}/mcp`)
		} as Parameters<typeof GET>[0]);
		expect(response).toBeInstanceOf(Response);
	});

	it('DELETE responds without an active session', async () => {
		const response = await DELETE({
			request: new Request(`${baseUrl}/mcp`, { method: 'DELETE' })
		} as Parameters<typeof DELETE>[0]);
		expect(response).toBeInstanceOf(Response);
	});
});
