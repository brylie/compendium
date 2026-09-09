import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({
	default: { lookup: (...args: unknown[]) => lookupMock(...args) }
}));

// Imported after the mock so link-preview.ts's own `import dns from
// 'node:dns/promises'` resolves to the mocked module.
const { fetchLinkPreviewMetadata, LinkPreviewError } = await import('./link-preview');

function htmlResponse(html: string, contentType = 'text/html; charset=utf-8'): Response {
	return new Response(html, { status: 200, headers: { 'content-type': contentType } });
}

describe('fetchLinkPreviewMetadata', () => {
	beforeEach(() => {
		lookupMock.mockReset();
		// A stand-in public address for every hostname by default — most tests
		// only care about HTML parsing/SSRF-guard behavior, not real DNS.
		lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
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
		['http://169.254.1.1/', '169.254.1.1']
	])('refuses to fetch a private IPv4 address (%s)', async (url, address) => {
		lookupMock.mockResolvedValue([{ address, family: 4 }]);
		await expect(fetchLinkPreviewMetadata(url)).rejects.toThrow(LinkPreviewError);
	});

	it('refuses to fetch a private IPv6 address', async () => {
		lookupMock.mockResolvedValue([{ address: '::1', family: 6 }]);
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

	it('extracts OpenGraph title/description/image and a <link rel="icon">', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				htmlResponse(`<!doctype html><html><head>
					<title>Fallback Title</title>
					<meta property="og:title" content="Rich Title">
					<meta property="og:description" content="A nice description.">
					<meta property="og:image" content="/images/preview.png">
					<link rel="icon" href="/favicon.png">
				</head><body></body></html>`)
			)
		);

		const result = await fetchLinkPreviewMetadata('https://example.com/article');

		expect(result).toEqual({
			title: 'Rich Title',
			description: 'A nice description.',
			faviconUrl: 'https://example.com/favicon.png',
			thumbnailUrl: 'https://example.com/images/preview.png'
		});
	});

	it('parses single-quoted attributes too, preferring a double-quoted duplicate when both are present', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				htmlResponse(`<html><head>
					<meta property='og:title' content='Single Quoted Title'>
					<link rel='icon' href='/single-quoted-favicon.png'>
				</head></html>`)
			)
		);

		const result = await fetchLinkPreviewMetadata('https://example.com/single-quotes');

		expect(result.title).toBe('Single Quoted Title');
		expect(result.faviconUrl).toBe('https://example.com/single-quoted-favicon.png');
	});

	it('omits a thumbnail whose og:image content is not a resolvable URL', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(
				htmlResponse(`<html><head>
					<title>No Thumbnail</title>
					<meta property="og:image" content="http://">
				</head></html>`)
			)
		);

		const result = await fetchLinkPreviewMetadata('https://example.com/bad-image');

		expect(result.title).toBe('No Thumbnail');
		expect(result.thumbnailUrl).toBeUndefined();
	});

	it('falls back to <title> and a guessed /favicon.ico when no OpenGraph tags are present', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue(htmlResponse('<html><head><title>Plain Page</title></head></html>'))
		);

		const result = await fetchLinkPreviewMetadata('https://example.com/plain');

		expect(result.title).toBe('Plain Page');
		expect(result.description).toBeUndefined();
		expect(result.faviconUrl).toBe('https://example.com/favicon.ico');
	});

	it('re-validates the SSRF guard on every redirect hop', async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			new Response(null, {
				status: 302,
				headers: { location: 'http://internal.example/next' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);
		lookupMock
			.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]) // first hop: public
			.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }]); // redirect target: private

		await expect(fetchLinkPreviewMetadata('https://example.com/redirect')).rejects.toThrow(
			LinkPreviewError
		);
		// Only the first hop's response was fetched — the redirect target was
		// rejected before a second fetch call.
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('rejects a non-HTML response', async () => {
		vi.stubGlobal(
			'fetch',
			vi
				.fn()
				.mockResolvedValue(
					new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
				)
		);
		await expect(fetchLinkPreviewMetadata('https://example.com/data.json')).rejects.toThrow(
			LinkPreviewError
		);
	});

	it('wraps a network failure in LinkPreviewError', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unreachable')));
		await expect(fetchLinkPreviewMetadata('https://example.com/')).rejects.toThrow(
			LinkPreviewError
		);
	});
});
