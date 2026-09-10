import { error } from '@sveltejs/kit';
import { getBookmarkAssetUrl, type BookmarkAssetKind } from '$lib/services';
import { fetchImageAsset, LinkPreviewError } from '$lib/server/link-preview';
import type { RequestHandler } from './$types';

const ASSET_KINDS: readonly BookmarkAssetKind[] = ['favicon', 'thumbnail'];

function parseKind(value: string | null): BookmarkAssetKind {
	if (value !== null && (ASSET_KINDS as readonly string[]).includes(value)) {
		return value as BookmarkAssetKind;
	}
	error(400, 'kind must be "favicon" or "thumbnail".');
}

/**
 * Same-origin proxy for a bookmark block's favicon/thumbnail (issue #155
 * follow-up). `BookmarkBlock.svelte` points its `<img src>` here instead of
 * at the scraped URL directly: `resolvePublicAssetUrl` ($lib/server/link-
 * preview.ts) only ever validated that URL's hostname once, at scrape time
 * — a raw `<img src>` would leave the *viewer's own browser* to do a fresh
 * DNS resolution and follow any redirect the image host sends, neither of
 * which that one-time check can see. Routing every render through
 * `fetchImageAsset` re-validates and pins the connection (including each
 * redirect hop) on every request, server-side, before any bytes reach the
 * browser.
 *
 * `documentId` is optional for the same reason it's optional on
 * `refresh_bookmark_metadata` (see `getBookmarkAssetUrl`'s doc comment): only
 * a direct-UI-created bookmark needs the hint to resolve its shard.
 */
export const GET: RequestHandler = async ({ params, url, locals }) => {
	const kind = parseKind(url.searchParams.get('kind'));
	const documentId = url.searchParams.get('documentId') ?? undefined;

	const assetUrl = getBookmarkAssetUrl(locals.requestContext.caller, params.id, kind, documentId);

	let asset: Awaited<ReturnType<typeof fetchImageAsset>>;
	try {
		asset = await fetchImageAsset(assetUrl);
	} catch (err) {
		if (err instanceof LinkPreviewError) {
			error(502, `Could not fetch the ${kind} image: ${err.message}`);
		}
		throw err;
	}

	return new Response(new Uint8Array(asset.body), {
		headers: {
			'content-type': asset.contentType,
			// Proxied bytes for a URL the server already resolved once — safe to
			// let the browser cache for a while without re-proxying every render,
			// but private (not a shared/CDN cache) since access is still gated by
			// the caller's own permission check above.
			'cache-control': 'private, max-age=3600'
		}
	});
};
