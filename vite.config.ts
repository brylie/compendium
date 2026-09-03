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
			// down to workspace-store.ts's module-level context registry — would
			// resolve through that *other* context, creating a second, disconnected
			// Y.Doc that only the WebSocket layer ever sees: every live edit
			// silently stops showing up for connected clients while MCP/HTTP writes
			// report success. server.ssrLoadModule loads it through the same SSR
			// module graph the rest of the app uses instead, so there's exactly one
			// resolveWorkspaceContext() registry for this process.
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
			// Root-absolute, not route-depth-relative: %sveltekit.assets% links in
			// app.html (favicon) are static head elements the client router never
			// re-renders on SPA navigation, so a depth-relative href computed for
			// one route silently 404s after navigating to a route nested deeper
			// under /space/[spaceId]/... (e.g. doc/table pages vs. the Space root).
			paths: { relative: false },
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
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: [
						'src/**/*.svelte.{test,spec}.{js,ts}',
						'src/routes/mcp/server.test.ts',
						'tests/**/*.spec.{js,ts}',
						'tests/e2e/**',
						'tests/benchmark/**',
						'src/lib/client/**/*.{test,spec}.{js,ts}'
					],
					setupFiles: ['./tests/setup/isolate-persistence.ts']
				}
			},
			{
				extends: './vite.config.ts',
				test: {
					name: 'integration',
					environment: 'node',
					include: ['tests/e2e/**/*.test.{js,ts}', 'src/routes/mcp/server.test.ts'],
					setupFiles: ['./tests/setup/isolate-persistence.ts'],
					fileParallelism: false
				}
			},
			{
				extends: './vite.config.ts',
				test: {
					name: 'benchmark',
					environment: 'node',
					include: ['tests/benchmark/**/*.test.ts'],
					setupFiles: ['./tests/setup/isolate-persistence.ts'],
					fileParallelism: false,
					testTimeout: 120_000
				}
			},
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					environment: 'jsdom',
					include: ['src/lib/client/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/lib/client/**/*.svelte.{test,spec}.{js,ts}']
				}
			},
			{
				extends: './vite.config.ts',
				// Vitest runs in Node, so Vite's package resolution defaults to the
				// server (SSR) condition — which for the `svelte` package points at
				// index-server.js, a build that doesn't implement mount(). Component
				// tests need the client runtime instead, per
				// https://svelte.dev/docs/svelte/testing#Using-vitest.
				resolve: { conditions: ['browser'] },
				test: {
					name: 'component',
					environment: 'jsdom',
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					setupFiles: ['./tests/setup/component.ts']
				}
			}
		],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'text-summary', 'html'],
			include: ['src/**/*.{js,ts}', 'src/**/*.svelte'],
			exclude: ['src/**/*.{test,spec}.{js,ts}', 'src/**/*.svelte.{test,spec}.{js,ts}'],
			thresholds: {
				statements: 80,
				branches: 80,
				functions: 80,
				lines: 80
			}
		}
	}
});
