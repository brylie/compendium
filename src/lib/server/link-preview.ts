import dns from 'node:dns/promises';

// Server-side OpenGraph/plain-<title> scraper for bookmark blocks (issue
// #155). No HTML-parsing dependency is added for this — the codebase has no
// DOM parser in its production dependencies (jsdom is dev-only, for tests),
// and a small regex-based extractor is enough for the handful of <meta>/
// <link>/<title> tags a preview card actually needs.

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

/** Thrown for any failure fetching or parsing a bookmark's preview — refreshBookmarkMetadata (services/records.ts) catches this and degrades to `{status: 'error'}` rather than letting it propagate, per the PRD's "always retains an accessible plain link as a fallback" requirement. */
export class LinkPreviewError extends Error {}

// Blocks loopback/private/link-local/unique-local/reserved ranges so this
// server-side fetch of a caller-supplied URL can't be used to probe internal
// infrastructure (SSRF) — checked against the URL's *resolved* address, not
// just its hostname string, so a DNS name that resolves to an internal IP is
// caught the same way a literal internal IP would be.
function isPrivateIPv4(address: string): boolean {
	const parts = address.split('.').map(Number);
	if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true; // malformed — fail closed
	const [a, b] = parts;
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 169 && b === 254) return true; // link-local
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a >= 224) return true; // multicast/reserved
	return false;
}

function isPrivateIPv6(address: string): boolean {
	const normalized = address.toLowerCase();
	if (normalized === '::1' || normalized === '::') return true;
	if (normalized.startsWith('fe80:')) return true; // link-local
	if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local (fc00::/7)
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
	if (mapped) return isPrivateIPv4(mapped[1]);
	return false;
}

async function assertPublicHostname(hostname: string): Promise<void> {
	let results: { address: string; family: number }[];
	try {
		results = await dns.lookup(hostname, { all: true, verbatim: true });
	} catch {
		throw new LinkPreviewError(`Could not resolve hostname ${hostname}`);
	}
	if (results.length === 0) throw new LinkPreviewError(`Could not resolve hostname ${hostname}`);
	for (const { address, family } of results) {
		const isPrivate = family === 6 ? isPrivateIPv6(address) : isPrivateIPv4(address);
		if (isPrivate) {
			throw new LinkPreviewError('Refusing to fetch a private/internal address');
		}
	}
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return '';
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		chunks.push(value);
		if (total > maxBytes) {
			await reader.cancel();
			break;
		}
	}
	return Buffer.concat(chunks).toString('utf-8');
}

// `redirect: 'manual'` plus this loop (rather than fetch's own automatic
// redirect-following) so every hop's hostname is re-validated against
// assertPublicHostname — an unchecked redirect chain is a classic SSRF bypass
// (a public first hop 302-ing to an internal address).
async function fetchWithGuards(
	url: URL,
	redirectsLeft: number
): Promise<{ finalUrl: URL; html: string }> {
	if (!['http:', 'https:'].includes(url.protocol)) {
		throw new LinkPreviewError('Only http/https URLs are supported');
	}
	await assertPublicHostname(url.hostname);

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(url, {
			signal: controller.signal,
			redirect: 'manual',
			headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,*/*;q=0.5' }
		});
	} catch (err) {
		throw new LinkPreviewError(err instanceof Error ? err.message : 'Fetch failed');
	} finally {
		clearTimeout(timeout);
	}

	if (response.status >= 300 && response.status < 400) {
		const location = response.headers.get('location');
		if (!location || redirectsLeft <= 0) {
			throw new LinkPreviewError('Redirect with no Location header, or too many redirects');
		}
		return fetchWithGuards(new URL(location, url), redirectsLeft - 1);
	}
	if (!response.ok) {
		throw new LinkPreviewError(`Fetch failed with status ${response.status}`);
	}
	const contentType = response.headers.get('content-type') ?? '';
	if (!contentType.includes('html')) {
		throw new LinkPreviewError('URL did not return HTML content');
	}
	const html = await readBoundedText(response, MAX_RESPONSE_BYTES);
	return { finalUrl: url, html };
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
// URL (after redirects), keeping only http(s) results — a `javascript:`/
// `data:` href in a <link>/<meta> tag must never end up rendered as an <img
// src> or <a href> in BookmarkBlock.svelte.
function resolveAssetUrl(href: string | undefined, base: URL): string | undefined {
	if (!href) return undefined;
	try {
		const resolved = new URL(href, base);
		return ['http:', 'https:'].includes(resolved.protocol) ? resolved.href : undefined;
	} catch {
		return undefined;
	}
}

function extractFavicon(html: string, finalUrl: URL): string | undefined {
	const linkTags = extractLinkTags(html);
	const iconTag = linkTags.find((t) => (t.rel ?? '').toLowerCase().split(/\s+/).includes('icon'));
	const resolved = resolveAssetUrl(iconTag?.href, finalUrl);
	// No <link rel="icon"> found — /favicon.ico at the site's own origin is a
	// long-standing convention (pre-dating <link rel="icon"> itself); offered
	// as a best-effort guess, not a verified one — BookmarkBlock.svelte
	// already treats a broken favicon image as decorative-and-hideable.
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

	return {
		title: metaContent(metaTags, ['og:title', 'twitter:title']) ?? extractTitle(html),
		description: metaContent(metaTags, ['og:description', 'twitter:description', 'description']),
		faviconUrl: extractFavicon(html, finalUrl),
		thumbnailUrl: resolveAssetUrl(metaContent(metaTags, ['og:image', 'twitter:image']), finalUrl)
	};
}
