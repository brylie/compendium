import dns from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import type { IncomingMessage } from 'node:http';

// Server-side OpenGraph/plain-<title> scraper for bookmark blocks (issue
// #155). No HTML-parsing dependency is added for this — the codebase has no
// DOM parser in its production dependencies (jsdom is dev-only, for tests),
// and a small regex-based extractor is enough for the handful of <meta>/
// <link>/<title> tags a preview card actually needs.
//
// Uses node:http/node:https directly rather than the global `fetch` so the
// actual TCP connection can be pinned to the exact address
// `resolvePublicAddress` already validated (via each request's own `lookup`
// option) — `fetch`'s internal DNS resolution happens independently of any
// earlier check and could resolve a *different* address at connect time
// (a DNS-rebinding race), silently defeating the SSRF guard between the
// check and the real connection.

const FETCH_TIMEOUT_MS = 5000;
// Enough for a page's <head> plus generous slop; bounds memory/latency for a
// caller-supplied URL that could otherwise stream an arbitrarily large body.
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = 'CompendiumBot/1.0 (+bookmark preview fetcher)';

export interface FetchedLinkMetadata {
	title?: string;
	description?: string;
	faviconUrl?: string;
	thumbnailUrl?: string;
}

/** Thrown for any failure fetching or parsing a bookmark's preview — refreshBookmarkMetadata (services/records.ts) catches this and degrades to a `status: 'error'` result rather than letting it propagate, per the PRD's "always retains an accessible plain link as a fallback" requirement. */
export class LinkPreviewError extends Error {}

// Blocks loopback/private/link-local/unique-local/reserved/CGNAT ranges so
// this server-side fetch of a caller-supplied URL can't be used to probe
// internal infrastructure (SSRF) — checked against the URL's *resolved*
// address, not just its hostname string, so a DNS name that resolves to an
// internal IP is caught the same way a literal internal IP would be.
function isPrivateIPv4(address: string): boolean {
	const parts = address.split('.').map(Number);
	if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true; // malformed — fail closed
	const [a, b, c] = parts;
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (RFC 6598)
	if (a === 169 && b === 254) return true; // link-local
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments (RFC 6890)
	if (a === 192 && b === 168) return true;
	if (a >= 224) return true; // multicast/reserved
	return false;
}

// Bitwise-masked against the address's first 16-bit group rather than a
// literal string-prefix match, which only ever caught exactly "fe80:" and
// missed the rest of the fe80::/10 link-local range (fe80: through febf:).
function isPrivateIPv6(address: string): boolean {
	const normalized = address.toLowerCase();
	if (normalized === '::1' || normalized === '::') return true;
	const firstGroup = parseInt(normalized.split(':')[0] || '0', 16);
	if (!Number.isNaN(firstGroup)) {
		if ((firstGroup & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
		if ((firstGroup & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
	}
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
	if (mapped) return isPrivateIPv4(mapped[1]);
	return false;
}

interface ResolvedAddress {
	address: string;
	family: number;
}

/** Resolves `hostname`, throwing if any candidate address is private/internal, and returns the first address — the caller pins its actual connection to this exact address (see `requestHop`) rather than letting the HTTP client re-resolve independently. */
async function resolvePublicAddress(hostname: string): Promise<ResolvedAddress> {
	let results: ResolvedAddress[];
	try {
		results = await dns.lookup(hostname, { all: true, verbatim: true });
	} catch {
		throw new LinkPreviewError(`Could not resolve hostname ${hostname}`);
	}
	if (results.length === 0) throw new LinkPreviewError(`Could not resolve hostname ${hostname}`);
	for (const { address, family } of results) {
		const isPrivate = family === 6 ? isPrivateIPv6(address) : isPrivateIPv4(address);
		if (isPrivate) throw new LinkPreviewError('Refusing to fetch a private/internal address');
	}
	return results[0];
}

/** True when `hostname` resolves entirely to public addresses — gates a scraped favicon/thumbnail URL before it's persisted, so a malicious page can't point every future viewer's own browser at an internal address via an `<img src>` (the primary-fetch SSRF guard above only ever covered the HTML fetch itself, not asset URLs *found inside* that HTML). */
async function isPublicHostname(hostname: string): Promise<boolean> {
	try {
		await resolvePublicAddress(hostname);
		return true;
	} catch {
		return false;
	}
}

interface RawResponse {
	statusCode: number;
	headers: http.IncomingHttpHeaders;
	body: IncomingMessage;
}

// Connects directly to `address` (already validated by resolvePublicAddress)
// via each request's own `lookup` option, instead of letting http/https
// re-resolve `url.hostname` independently — closing the DNS-rebinding window
// between validation and connection. `hostname`/`servername` stay the
// original name so the Host header and TLS SNI/certificate validation are
// unaffected. Returns the pending response promise plus a `destroy` handle
// so the caller can enforce one deadline spanning connect *and* body read
// (see `fetchWithGuards`) rather than just until headers arrive.
function requestHop(
	url: URL,
	address: string,
	family: number
): { response: Promise<RawResponse>; destroy: (err: Error) => void } {
	const isHttps = url.protocol === 'https:';
	const client = isHttps ? https : http;
	let req!: http.ClientRequest;
	const response = new Promise<RawResponse>((resolve, reject) => {
		req = client.request({
			hostname: url.hostname,
			...(isHttps ? { servername: url.hostname } : {}),
			port: url.port || (isHttps ? 443 : 80),
			path: `${url.pathname}${url.search}`,
			method: 'GET',
			headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,*/*;q=0.5' },
			lookup: (_hostname, _options, callback) => {
				callback(null, address, family);
			}
		});
		req.on('response', (res) => {
			resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: res });
		});
		req.on('error', (err) => {
			reject(err instanceof LinkPreviewError ? err : new LinkPreviewError(err.message));
		});
		req.end();
	});
	return { response, destroy: (err) => req.destroy(err) };
}

/** Reads at most `maxBytes` from `body`, aborting the connection once exceeded — bounds memory for a caller-supplied URL that could otherwise stream an arbitrarily large response. Any stream error (including a deadline-triggered destroy — see `fetchWithGuards`) surfaces as `LinkPreviewError`. */
async function readBoundedBody(body: IncomingMessage, maxBytes: number): Promise<string> {
	const chunks: Buffer[] = [];
	let total = 0;
	try {
		for await (const chunk of body as AsyncIterable<Buffer>) {
			total += chunk.length;
			chunks.push(chunk);
			if (total > maxBytes) {
				body.destroy();
				break;
			}
		}
	} catch (err) {
		throw new LinkPreviewError(err instanceof Error ? err.message : 'Failed reading response body');
	}
	return Buffer.concat(chunks).toString('utf-8');
}

// A plain, non-redirect-following GET per hop, plus this loop, so every hop's
// hostname is re-validated against resolvePublicAddress — an unchecked
// redirect chain is a classic SSRF bypass (a public first hop 302-ing to an
// internal address). `deadline` spans the *entire* hop — connect through the
// full bounded body read, not just until headers arrive — so a server that
// sends headers and then stalls (or trickles) its body stream can't hold the
// call open indefinitely; a bare per-connect timeout alone wouldn't catch a
// slow-but-technically-still-flowing body.
async function fetchWithGuards(
	url: URL,
	redirectsLeft: number
): Promise<{ finalUrl: URL; html: string }> {
	if (!['http:', 'https:'].includes(url.protocol)) {
		throw new LinkPreviewError('Only http/https URLs are supported');
	}
	const { address, family } = await resolvePublicAddress(url.hostname);

	const { response, destroy } = requestHop(url, address, family);
	const deadline = setTimeout(
		() => destroy(new LinkPreviewError('Request timed out')),
		FETCH_TIMEOUT_MS
	);
	try {
		const { statusCode, headers, body } = await response;

		if (statusCode >= 300 && statusCode < 400) {
			body.resume(); // discard the redirect body without reading it
			const location = headers.location;
			if (!location || redirectsLeft <= 0) {
				throw new LinkPreviewError('Redirect with no Location header, or too many redirects');
			}
			return await fetchWithGuards(new URL(location, url), redirectsLeft - 1);
		}
		if (statusCode < 200 || statusCode >= 300) {
			body.resume();
			throw new LinkPreviewError(`Fetch failed with status ${statusCode}`);
		}
		const contentType = String(headers['content-type'] ?? '');
		if (!contentType.includes('html')) {
			body.resume();
			throw new LinkPreviewError('URL did not return HTML content');
		}
		const html = await readBoundedBody(body, MAX_RESPONSE_BYTES);
		return { finalUrl: url, html };
	} finally {
		clearTimeout(deadline);
	}
}

function decodeHtmlEntities(text: string): string {
	return text
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#0*39;|&apos;/g, "'");
}

// Split into two single-quote-style patterns rather than one pattern with a
// `"..."|'...'` alternation, and no whitespace allowed around `=` (real-world
// meta/link tags essentially always write `name="value"` with no spacing).
// Each quantified group is separated from the next by a mandatory literal
// (`="`/`'`) that neither group's own character class can match, so there is
// no ambiguous partitioning for the engine to backtrack over — sonarjs'
// static heuristic still flags any regex with more than one unbounded
// quantifier regardless, which is a known false-positive class for this
// shape (attr-name, then a disjoint delimited value).
// eslint-disable-next-line sonarjs/super-linear-regex -- see comment above; each quantifier is delimiter-bounded, not nested/overlapping
const DOUBLE_QUOTED_ATTR_RE = /([a-zA-Z][a-zA-Z0-9-]*)="([^"]*)"/g;
// eslint-disable-next-line sonarjs/super-linear-regex -- see comment above; each quantifier is delimiter-bounded, not nested/overlapping
const SINGLE_QUOTED_ATTR_RE = /([a-zA-Z][a-zA-Z0-9-]*)='([^']*)'/g;

function parseTagAttrs(tag: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	for (const match of tag.matchAll(DOUBLE_QUOTED_ATTR_RE)) {
		attrs[match[1].toLowerCase()] = decodeHtmlEntities(match[2]);
	}
	for (const match of tag.matchAll(SINGLE_QUOTED_ATTR_RE)) {
		const name = match[1].toLowerCase();
		if (!(name in attrs)) attrs[name] = decodeHtmlEntities(match[2]);
	}
	return attrs;
}

const META_TAG_RE = /<meta\b[^>]*>/gi;
const LINK_TAG_RE = /<link\b[^>]*>/gi;

function extractMetaTags(html: string): Record<string, string>[] {
	return [...html.matchAll(META_TAG_RE)].map((m) => parseTagAttrs(m[0]));
}

function extractLinkTags(html: string): Record<string, string>[] {
	return [...html.matchAll(LINK_TAG_RE)].map((m) => parseTagAttrs(m[0]));
}

function metaContent(tags: Record<string, string>[], keys: string[]): string | undefined {
	for (const key of keys) {
		const tag = tags.find(
			(t) => t.property?.toLowerCase() === key || t.name?.toLowerCase() === key
		);
		if (tag?.content) return tag.content.trim() || undefined;
	}
	return undefined;
}

function extractTitle(html: string): string | undefined {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	if (!match) return undefined;
	const title = decodeHtmlEntities(match[1]).replace(/\s+/g, ' ').trim();
	return title || undefined;
}

// Resolves a possibly-relative icon/image href against the page's own final
// URL (after redirects), keeping only http(s) results whose host resolves
// publicly — a `javascript:`/`data:` href must never end up rendered as an
// <img src>/<a href> in BookmarkBlock.svelte, and a private/internal-pointing
// one must never be persisted for every future viewer's browser to request.
async function resolvePublicAssetUrl(
	href: string | undefined,
	base: URL
): Promise<string | undefined> {
	if (!href) return undefined;
	let resolved: URL;
	try {
		resolved = new URL(href, base);
	} catch {
		return undefined;
	}
	if (!['http:', 'https:'].includes(resolved.protocol)) return undefined;
	return (await isPublicHostname(resolved.hostname)) ? resolved.href : undefined;
}

async function extractFavicon(html: string, finalUrl: URL): Promise<string | undefined> {
	const linkTags = extractLinkTags(html);
	const iconTag = linkTags.find((t) => (t.rel ?? '').toLowerCase().split(/\s+/).includes('icon'));
	const resolved = await resolvePublicAssetUrl(iconTag?.href, finalUrl);
	// No <link rel="icon"> found (or it pointed at a private address) —
	// /favicon.ico at the site's own origin is a long-standing convention
	// (pre-dating <link rel="icon"> itself), offered as a best-effort guess,
	// not a verified one — BookmarkBlock.svelte already treats a broken
	// favicon image as decorative-and-hideable. finalUrl's own hostname was
	// already validated public by fetchWithGuards, so this fallback needs no
	// separate check.
	return resolved ?? `${finalUrl.origin}/favicon.ico`;
}

/**
 * Fetches `rawUrl` server-side and scrapes OpenGraph/plain-HTML metadata for
 * a bookmark block's preview card — the one place in the codebase that makes
 * an outbound request to a caller-supplied URL, so every guard (scheme,
 * private-address, timeout, redirect re-validation, response-size cap) lives
 * here rather than at each call site. Throws `LinkPreviewError` for any
 * failure; callers (refreshBookmarkMetadata, services/records.ts) are
 * expected to catch it and degrade to an error status with the url itself
 * still available as a plain link, never to let it reach an MCP/UI caller as
 * an unhandled rejection.
 */
export async function fetchLinkPreviewMetadata(rawUrl: string): Promise<FetchedLinkMetadata> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new LinkPreviewError(`Invalid URL: ${rawUrl}`);
	}

	const { finalUrl, html } = await fetchWithGuards(url, MAX_REDIRECTS);
	const metaTags = extractMetaTags(html);

	const [faviconUrl, thumbnailUrl] = await Promise.all([
		extractFavicon(html, finalUrl),
		resolvePublicAssetUrl(metaContent(metaTags, ['og:image', 'twitter:image']), finalUrl)
	]);

	return {
		title: metaContent(metaTags, ['og:title', 'twitter:title']) ?? extractTitle(html),
		description: metaContent(metaTags, ['og:description', 'twitter:description', 'description']),
		faviconUrl,
		thumbnailUrl
	};
}
