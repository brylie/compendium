import type { Server } from 'node:http';

/**
 * Start a test HTTP server on loopback and propagate bind failures immediately.
 *
 * Test suites deliberately use an ephemeral port, but they must not silently
 * hang when the environment denies listening sockets. The temporary listeners
 * are removed whichever event settles first so later server errors retain their
 * normal Node handling.
 */
export function listenOnLoopback(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		const onListening = () => {
			cleanup();
			const address = server.address();
			if (address && typeof address === 'object') {
				resolve(address.port);
				return;
			}
			reject(new Error('Test server started without a TCP address'));
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const cleanup = () => {
			server.removeListener('listening', onListening);
			server.removeListener('error', onError);
		};

		server.once('listening', onListening);
		server.once('error', onError);
		server.listen({ port: 0, host: '127.0.0.1' });
	});
}

/** Close a test server without treating a failed startup as a second failure. */
export function closeTestServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => {
			if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
				reject(error);
				return;
			}
			resolve();
		});
	});
}
