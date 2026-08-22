import { getYDoc } from '$lib/server/ydoc';
import { listCollections, listDocuments, listRecordsForParent } from '$lib/data/records';
import { logAudit } from '$lib/server/audit';
import { tokenAllowsParent } from '$lib/mcp/tokens';
import { richTextToMarkdown } from '$lib/mcp/markdown-transcode';
import { actorForCaller, isAccessToken, type CallerIdentity } from './permissions';

function snippetAround(text: string, needle: string): string {
	const index = text.toLowerCase().indexOf(needle);
	if (index === -1) return text.slice(0, 80);
	const start = Math.max(0, index - 30);
	const end = Math.min(text.length, index + needle.length + 30);
	return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

export function searchWorkspace(
	caller: CallerIdentity,
	query: string
): Array<{ recordId: string; snippet: string }> {
	const doc = getYDoc();
	const actor = actorForCaller(caller);
	const needle = query.toLowerCase();
	const results: Array<{ recordId: string; snippet: string }> = [];

	for (const document of listDocuments(doc)) {
		if (isAccessToken(caller) && !tokenAllowsParent(caller, document.id)) continue;
		for (const record of listRecordsForParent(doc, document.id)) {
			const text = record.content ? richTextToMarkdown(doc, record.content) : '';
			if (text.toLowerCase().includes(needle)) {
				results.push({ recordId: record.id, snippet: snippetAround(text, needle) });
			}
		}
	}

	for (const collection of listCollections(doc)) {
		if (isAccessToken(caller) && !tokenAllowsParent(caller, collection.id)) continue;
		for (const row of listRecordsForParent(doc, collection.id)) {
			for (const value of Object.values(row.properties ?? {})) {
				const text = value.type === 'text' || value.type === 'select' ? value.value : '';
				if (text.toLowerCase().includes(needle)) {
					results.push({ recordId: row.id, snippet: snippetAround(text, needle) });
					break;
				}
			}
		}
	}

	logAudit({
		actor,
		action: 'search_workspace',
		diff: { query, count: results.length }
	});
	return results;
}
