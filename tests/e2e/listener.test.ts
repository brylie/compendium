import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { closeTestServer, listenOnLoopback } from './listener';

describe('test listener lifecycle', () => {
	it('rejects immediately with the original listener error and removes its temporary listeners', async () => {
		const server = createServer();
		const initialListeningListeners = server.listenerCount('listening');
		const bindError = Object.assign(new Error('listen EPERM: operation not permitted 127.0.0.1'), {
			code: 'EPERM'
		});
		vi.spyOn(server, 'listen').mockImplementation(() => {
			queueMicrotask(() => server.emit('error', bindError));
			return server;
		});

		await expect(listenOnLoopback(server)).rejects.toBe(bindError);
		expect(server.listenerCount('error')).toBe(0);
		expect(server.listenerCount('listening')).toBe(initialListeningListeners);
	});

	it('allows cleanup after partial initialization when the server never listened', async () => {
		const server = createServer();
		await expect(closeTestServer(server)).resolves.toBeUndefined();
	});
});
