import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vitest/config';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
// Preview mode only: serves the pre-built app, so there's no Vite SSR module
// graph to load attach-ws.ts through — a plain import is correct there.
import { attachYjsWebSocket } from './src/lib/server/attach-ws.js';

// Attaches the /ws Yjs sync endpoint to Vite's own HTTP server in dev and
// preview, so a single `npm run dev` matches the one-process architecture in
// docs/technical-design.md §1 (production uses server.js for the same thing).
function yjsWebSocketPlugin(): Plugin {
	return {
		name: 'yjs-ws',
		async configureServer(server) {
			if (!server.httpServer) return;
			// Vite loads vite.config.ts itself through a separate module-resolution
			// context from the one it uses for the app's SSR code at request time
			// (+page.server.ts, the /mcp route, the service layer). A plain
			// top-level `import` of attach-ws.ts here — and everything it pulls in,
			// down to ydoc.ts's module-level Y.Doc singleton — would resolve
			// through that *other* context, creating a second, disconnected Y.Doc
			// that only the WebSocket layer ever sees: every live edit silently
			// stops showing up for connected clients while MCP/HTTP writes report
			// success. server.ssrLoadModule loads it through the same SSR module
			// graph the rest of the app uses instead, so there's exactly one
			// getYDoc() singleton for this process.
			const mod = await server.ssrLoadModule('/src/lib/server/attach-ws.ts');
			(mod.attachYjsWebSocket as typeof attachYjsWebSocket)(server.httpServer);
		},

		configurePreviewServer(server) {
			if (server.httpServer) attachYjsWebSocket(server.httpServer);
		}
	};
}

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			typescript: {
				config: (config) => {
					config.include.push('../drizzle.config.ts');
				}
			}
		}),
		yjsWebSocketPlugin()
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}', 'tests/**/*.test.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}', 'tests/**/*.spec.{js,ts}'],
					setupFiles: ['./tests/setup/isolate-persistence.ts']
				}
			}
		]
	}
});
