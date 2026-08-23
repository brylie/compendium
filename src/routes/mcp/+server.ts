import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from '$lib/mcp/server';
import type { RequestHandler } from './$types';

// Phase 0: HTTP MCP transport, stateless (no sessionIdGenerator) — each
// request re-authenticates via its own bearer token rather than relying on
// server-held session state (docs/technical-design.md §1, §7).

function extractBearerToken(request: Request): string | undefined {
	const header = request.headers.get('authorization');
	if (!header?.startsWith('Bearer ')) return undefined;
	return header.slice('Bearer '.length).trim();
}

async function handle(request: Request): Promise<Response> {
	const server = createMcpServer();
	const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
	await server.connect(transport);

	const token = extractBearerToken(request);
	return transport.handleRequest(request, {
		authInfo: token ? { token, clientId: 'local', scopes: [] } : undefined
	});
}

export const POST: RequestHandler = ({ request }) => handle(request);
export const GET: RequestHandler = ({ request }) => handle(request);
export const DELETE: RequestHandler = ({ request }) => handle(request);
