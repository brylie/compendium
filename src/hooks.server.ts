import type { Handle } from '@sveltejs/kit';
import { resolveRequestContext } from '$lib/server/request-context';

// Builds the trusted RequestContext once per request (#111/#138) — the one
// place workspace/Space scope gets resolved from server configuration for
// every page load and form action, so route handlers don't each
// independently import the global CURRENT_USER or implicitly default a
// workspace. This runs for every HTTP request the SvelteKit router handles,
// including /mcp's own routing layer, but MCP tool handlers don't consume
// locals.requestContext — each tool call resolves its own caller from the
// request's bearer token independently (src/lib/mcp/server.ts), which this
// default (CURRENT_USER-based) context correctly has no way to know. The
// WebSocket upgrade is a different boundary entirely (attach-ws.ts), never
// routed through SvelteKit's handle at all.
export const handle: Handle = async ({ event, resolve }) => {
	event.locals.requestContext = resolveRequestContext();
	return resolve(event);
};
