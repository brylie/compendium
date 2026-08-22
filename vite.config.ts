import { defineConfig, type Plugin } from 'vitest/config';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { attachYjsWebSocket } from './src/lib/server/attach-ws.js';

// Attaches the /ws Yjs sync endpoint to Vite's own HTTP server in dev and
// preview, so a single `npm run dev` matches the one-process architecture in
// docs/technical-design.md §1 (production uses server.js for the same thing).
function yjsWebSocketPlugin(): Plugin {
	return {
		name: 'agentspace-yjs-ws',
		configureServer(server) {
			if (server.httpServer) attachYjsWebSocket(server.httpServer);
		},
		configurePreviewServer(server) {
			if (server.httpServer) attachYjsWebSocket(server.httpServer);
		}
	};
}

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
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
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
