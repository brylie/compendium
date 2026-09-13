import { error } from '@sveltejs/kit';
import { exportWorkspace, exportDocument, exportCollection } from '$lib/services/export';
import type { RequestHandler } from './$types';

/** Exports workspace data, a single Document, or a Collection as downloadable files. */
export const GET: RequestHandler = async ({ url, locals }) => {
	const scope = url.searchParams.get('scope') ?? 'workspace';
	const id = url.searchParams.get('id') ?? undefined;
	const spaceId = url.searchParams.get('spaceId') ?? undefined;
	const caller = locals.requestContext.caller;

	try {
		if (scope === 'document' && id) {
			const docResult = exportDocument(caller, id);
			return new Response(docResult.markdown, {
				headers: {
					'Content-Type': 'text/markdown; charset=utf-8',
					'Content-Disposition': `attachment; filename="${encodeURIComponent(docResult.title)}.md"`
				}
			});
		}

		if (scope === 'collection' && id) {
			const colResult = exportCollection(caller, id);
			const format = url.searchParams.get('format') ?? 'csv';
			if (format === 'json') {
				return new Response(colResult.recordsJson, {
					headers: {
						'Content-Type': 'application/json; charset=utf-8',
						'Content-Disposition': `attachment; filename="${encodeURIComponent(colResult.collection.title)}.json"`
					}
				});
			}
			return new Response(colResult.recordsCsv, {
				headers: {
					'Content-Type': 'text/csv; charset=utf-8',
					'Content-Disposition': `attachment; filename="${encodeURIComponent(colResult.collection.title)}.csv"`
				}
			});
		}

		// Default: Full workspace export ZIP
		const workspaceResult = exportWorkspace(caller, spaceId);
		const filename = `workspace-export-${new Date().toISOString().slice(0, 10)}.zip`;

		return new Response(Buffer.from(workspaceResult.zipBuffer), {
			headers: {
				'Content-Type': 'application/zip',
				'Content-Disposition': `attachment; filename="${filename}"`
			}
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Export failed';
		error(400, message);
	}
};
