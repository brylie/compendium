import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const lookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({
	default: { lookup: (...args: unknown[]) => lookupMock(...args) }
}));

// link-preview.ts talks to node:http/node:https directly (not the global
// fetch) so it can pin each connection to an already-validated address — see
// its own doc comment. Mocked here with a small fake request/response pair
// built on real Node primitives (EventEmitter, Readable) so the module's
// actual request/response/stream-destroy handling is exercised, not just a
// pre-resolved Promise the way a global-fetch mock would.
type FakeResponse = Readable & { statusCode: number; headers: Record<string, string> };

interface QueuedResponse {
	statusCode: number;
	headers: Record<string, string>;
	body?: string;
	stream?: FakeResponse;
	error?: Error;
}

let responseQueue: QueuedResponse[] = [];
let requestUrls: string[] = [];
let lastDestroy: ((err?: Error) => void) | undefined;
let lastLookupOption: ((...args: unknown[]) => void) | undefined;
let lastHeaders: Record<string, string> | undefined;

function makeFakeResponse(
	statusCode: number,
	headers: Record<string, string>,
	body: string
): FakeResponse {
	const res = Readable.from([Buffer.from(body)]) as FakeResponse;
	res.statusCode = statusCode;
	res.headers = headers;
	return res;
}

function fakeRequest(options: Record<string, unknown>) {
	const req = new EventEmitter() as EventEmitter & {
		destroy: (err?: Error) => void;
		end: () => void;
	};
	requestUrls.push(`${String(options.hostname)}${(options.path as string | undefined) ?? ''}`);
	lastLookupOption = options.lookup as (...args: unknown[]) => void;
	lastHeaders = options.headers as Record<string, string>;
	let destroyed = false;
	let currentRes: FakeResponse | undefined;
	req.destroy = (err?: Error) => {
		if (destroyed) return;
		destroyed = true;
		if (currentRes) currentRes.destroy(err ?? new Error('destroyed'));
		else if (err) req.emit('error', err);
	};
	lastDestroy = req.destroy;
	req.end = () => {
		queueMicrotask(() => {
			if (destroyed) return;
			const next = responseQueue.shift();
			if (!next) {
				req.emit('error', new Error('no queued response for ' + String(options.path)));
				return;
			}
			if (next.error) {
				req.emit('error', next.error);
				return;
			}
			const res = next.stream ?? makeFakeResponse(next.statusCode, next.headers, next.body ?? '');
			currentRes = res;
			req.emit('response', res);
		});
	};
	return req;
}

vi.mock('node:http', () => ({ request: (opts: Record<string, unknown>) => fakeRequest(opts) }));
vi.mock('node:https', () => ({ request: (opts: Record<string, unknown>) => fakeRequest(opts) }));

// Imported after the mocks so link-preview.ts's own imports of
// node:dns/promises, node:http, and node:https resolve to the mocked modules.
const { fetchLinkPreviewMetadata, fetchImageAsset, LinkPreviewError } =
	await import('./link-preview');

function queueHtml(html: string, contentType = 'text/html; charset=utf-8', statusCode = 200): void {
	responseQueue.push({ statusCode, headers: { 'content-type': contentType }, body: html });
}

describe('fetchLinkPreviewMetadata', () => {
	beforeEach(() => {
		responseQueue = [];
		requestUrls = [];
		lastDestroy = undefined;
		lookupMock.mockReset();
		// A stand-in public address for every hostname by default — most tests
		// only care about HTML parsing/SSRF-guard behavior, not real DNS.
		lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('rejects a non-http(s) scheme before any network call', async () => {
		await expect(fetchLinkPreviewMetadata('ftp://example.com/file')).rejects.toThrow(
			LinkPreviewError
		);
		expect(lookupMock).not.toHaveBeenCalled();
	});

	it('rejects an invalid URL', async () => {
		await expect(fetchLinkPreviewMetadata('not a url')).rejects.toThrow(LinkPreviewError);
	});

	// A literal loopback/private IP resolves to itself with no real DNS lookup
	// needed (Node's dns.lookup on a literal address is a passthrough) — the
	// mock above still stands in for it, but returning the *actual* private
	// address here (rather than the public default) is what exercises the
	// guard.
	it.each([
		['http://127.0.0.1/', '127.0.0.1'],
		['http://10.1.2.3/', '10.1.2.3'],
		['http://192.168.1.1/', '192.168.1.1'],
		['http://169.254.1.1/', '169.254.1.1'],
		['http://100.64.0.1/', '100.64.0.1'], // CGNAT (RFC 6598)
		['http://192.0.0.1/', '192.0.0.1'] // IETF protocol assignments (RFC 6890)
	])('refuses to fetch a private IPv4 address (%s)', async (url, address) => {
		lookupMock.mockResolvedValue([{ address, family: 4 }]);
		await expect(fetchLinkPreviewMetadata(url)).rejects.toThrow(LinkPreviewError);
	});

	it.each([
		['::1', 6],
		['fe80::1', 6], // link-local (fe80::/10)
		['febf::1', 6], // still within fe80::/10 — a literal "fe80:" prefix match alone would miss this
		['fc00::1', 6], // unique local (fc00::/7)
		['::ffff:127.0.0.1', 6] // IPv4-mapped loopback
	])('refuses to fetch a private IPv6 address (%s)', async (address) => {
		lookupMock.mockResolvedValue([{ address, family: 6 }]);
		await expect(fetchLinkPreviewMetadata('http://example.com/')).rejects.toThrow(LinkPreviewError);
	});

	it('refuses a hostname that only resolves to a private address even when the URL itself looks public', async () => {
		// DNS rebinding-shaped case: a public-looking hostname resolving to an
		// internal address must still be blocked — the guard checks the
		// *resolved* address, not the URL string.
		lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
		await expect(
			fetchLinkPreviewMetadata('http://metadata.internal-looking.example/')
		).rejects.toThrow(LinkPreviewError);
	});

	it('pins the actual connection to the validated address, not a fresh resolution', async () => {
		// The core DNS-rebinding fix: the request options passed to
		// node:http/https must carry a `lookup` that always returns the exact
		// address resolvePublicAddress already validated, never re-resolving
		// the hostname independently.
		lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
		queueHtml('<html><head><title>Pinned</title></head></html>');

		await fetchLinkPreviewMetadata('http://example.com/');

		expect(lastLookupOption).toBeTypeOf('function');
		const callback = vi.fn();
		lastLookupOption!('example.com', {}, callback);
		expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
		// dns.lookup itself was only ever called once (the validation step) —
		// the actual connection never triggers a second, independent
		// resolution that could return a different address.
		expect(lookupMock).toHaveBeenCalledTimes(1);
	});

	it('answers a Happy-Eyeballs-shaped lookup call (options.all: true) with an address array, not just the single-address form', async () => {
		// Node's autoSelectFamily (default on since Node 18.13/20) calls a
		// custom `lookup` with `{all: true}` expecting `(err, addresses[])`
		// back — a lookup that only ever answers the single-address form
		// would silently break every real connection attempt.
		lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
		queueHtml('<html><head><title>Pinned</title></head></html>');

		await fetchLinkPreviewMetadata('http://example.com/');

		const callback = vi.fn();
		lastLookupOption!('example.com', { all: true }, callback);
		expect(callback).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
	});

	it('answers the legacy two-argument lookup(hostname, callback) form too', async () => {
		lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
		queueHtml('<html><head><title>Pinned</title></head></html>');

		await fetchLinkPreviewMetadata('http://example.com/');

		const callback = vi.fn();
		lastLookupOption!('example.com', callback);
		expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
	});

	it('requests an unencoded response so the plain-text extractors never see compressed bytes', async () => {
		lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
		queueHtml('<html><head><title>Plain</title></head></html>');

		await fetchLinkPreviewMetadata('http://example.com/');

		expect(lastHeaders?.['accept-encoding']).toBe('identity');
	});

	it('extracts OpenGraph title/description/image and a <link rel="icon">', async () => {
		queueHtml(`<!doctype html><html><head>
			<title>Fallback Title</title>
			<meta property="og:title" content="Rich Title">
			<meta property="og:description" content="A nice description.">
			<meta property="og:image" content="/images/preview.png">
			<link rel="icon" href="/favicon.png">
		</head><body></body></html>`);

		const result = await fetchLinkPreviewMetadata('https://example.com/article');

		expect(result).toEqual({
			title: 'Rich Title',
			description: 'A nice description.',
			faviconUrl: 'https://example.com/favicon.png',
			thumbnailUrl: 'https://example.com/images/preview.png'
		});
	});

	it('parses single-quoted attributes too, preferring a double-quoted duplicate when both are present', async () => {
		queueHtml(`<html><head>
			<meta property='og:title' content='Single Quoted Title'>
			<link rel='icon' href='/single-quoted-favicon.png'>
		</head></html>`);

		const result = await fetchLinkPreviewMetadata('https://example.com/single-quotes');

		expect(result.title).toBe('Single Quoted Title');
		expect(result.faviconUrl).toBe('https://example.com/single-quoted-favicon.png');
	});

	it('omits a thumbnail whose og:image content is not a resolvable URL', async () => {
		queueHtml(`<html><head>
			<title>No Thumbnail</title>
			<meta property="og:image" content="http://">
		</head></html>`);

		const result = await fetchLinkPreviewMetadata('https://example.com/bad-image');

		expect(result.title).toBe('No Thumbnail');
		expect(result.thumbnailUrl).toBeUndefined();
	});

	it('drops a scraped thumbnail/favicon that resolves to a private address, instead of persisting it', async () => {
		// A malicious (or compromised) public page can still put a private
		// address in its own og:image/<link rel="icon"> — those must be
		// checked independently of the primary fetch's own SSRF guard, since
		// they're rendered as <img src> directly in every future viewer's
		// browser (BookmarkBlock.svelte), not fetched server-side again.
		queueHtml(`<html><head>
			<title>Malicious Page</title>
			<meta property="og:image" content="http://internal.example/probe.png">
			<link rel="icon" href="http://internal.example/favicon.png">
		</head></html>`);
		lookupMock
			.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]) // the page itself: public
			.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]); // every asset host: private

		const result = await fetchLinkPreviewMetadata('https://example.com/malicious');

		expect(result.title).toBe('Malicious Page');
		expect(result.thumbnailUrl).toBeUndefined();
		// Falls back to the page's own (already-validated-public) origin
		// rather than the malicious <link rel="icon">.
		expect(result.faviconUrl).toBe('https://example.com/favicon.ico');
	});

	it('falls back to <title> and a guessed /favicon.ico when no OpenGraph tags are present', async () => {
		queueHtml('<html><head><title>Plain Page</title></head></html>');

		const result = await fetchLinkPreviewMetadata('https://example.com/plain');

		expect(result.title).toBe('Plain Page');
		expect(result.description).toBeUndefined();
		expect(result.faviconUrl).toBe('https://example.com/favicon.ico');
	});

	it('re-validates the SSRF guard on every redirect hop', async () => {
		responseQueue.push({
			statusCode: 302,
			headers: { location: 'http://internal.example/next' },
			body: ''
		});
		lookupMock
			.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]) // first hop: public
			.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]); // redirect target: private

		await expect(fetchLinkPreviewMetadata('https://example.com/redirect')).rejects.toThrow(
			LinkPreviewError
		);
		// Only the first hop's request was made — the redirect target was
		// rejected before a second request.
		expect(requestUrls).toHaveLength(1);
	});

	it('rejects a non-HTML response', async () => {
		responseQueue.push({
			statusCode: 200,
			headers: { 'content-type': 'application/json' },
			body: '{}'
		});
		await expect(fetchLinkPreviewMetadata('https://example.com/data.json')).rejects.toThrow(
			LinkPreviewError
		);
	});

	it('wraps a network failure in LinkPreviewError', async () => {
		responseQueue.push({
			statusCode: 0,
			headers: {},
			error: new Error('network unreachable')
		});
		await expect(fetchLinkPreviewMetadata('https://example.com/')).rejects.toThrow(
			LinkPreviewError
		);
	});

	it('aborts a request whose body stalls past the deadline, instead of hanging indefinitely', async () => {
		vi.useFakeTimers();
		// A body stream that never pushes data and never ends — simulates a
		// server that sends headers, then stalls the stream. Only the
		// connect-through-body-read deadline (not a separate, already-cleared
		// per-connect timeout) can bound this.
		const stalledBody = new Readable({ read() {} }) as FakeResponse;
		stalledBody.statusCode = 200;
		stalledBody.headers = { 'content-type': 'text/html' };
		responseQueue.push({
			statusCode: 200,
			headers: { 'content-type': 'text/html' },
			stream: stalledBody
		});

		const pending = fetchLinkPreviewMetadata('https://example.com/slow');
		const assertion = expect(pending).rejects.toThrow(LinkPreviewError);

		// Let the queued microtask emit the 'response' event before advancing
		// timers, then advance past FETCH_TIMEOUT_MS (5000ms) to trigger the
		// deadline.
		await Promise.resolve();
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(6000);

		await assertion;
		expect(lastDestroy).toBeDefined();
	});
});

describe('fetchImageAsset', () => {
	beforeEach(() => {
		responseQueue = [];
		requestUrls = [];
		lastDestroy = undefined;
		lookupMock.mockReset();
		lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('fetches image bytes and content-type for a public asset url', async () => {
		responseQueue.push({
			statusCode: 200,
			headers: { 'content-type': 'image/png' },
			body: 'fake-png-bytes'
		});

		const result = await fetchImageAsset('https://example.com/favicon.png');

		expect(result.contentType).toBe('image/png');
		expect(result.body.toString('utf-8')).toBe('fake-png-bytes');
	});

	it('rejects a non-image content type', async () => {
		responseQueue.push({
			statusCode: 200,
			headers: { 'content-type': 'text/html' },
			body: '<html></html>'
		});

		await expect(fetchImageAsset('https://example.com/not-an-image')).rejects.toThrow(
			LinkPreviewError
		);
	});

	// The whole point of this proxy (see fetchImageAsset's own doc comment):
	// a scraped asset hostname was already validated once, at scrape time, but
	// a fresh resolution here (as if the viewer's browser had done it) must be
	// re-checked independently — this is that re-check, on the server side.
	it('refuses an asset url that resolves to a private address', async () => {
		lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);

		await expect(fetchImageAsset('https://example.com/favicon.png')).rejects.toThrow(
			LinkPreviewError
		);
	});

	it('re-validates the SSRF guard on a redirect the image host itself sends', async () => {
		responseQueue.push({
			statusCode: 302,
			headers: { location: 'http://internal.example/next.png' },
			body: ''
		});
		lookupMock
			.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]) // first hop: public
			.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]); // redirect target: private

		await expect(fetchImageAsset('https://example.com/redirect.png')).rejects.toThrow(
			LinkPreviewError
		);
		expect(requestUrls).toHaveLength(1);
	});
});
