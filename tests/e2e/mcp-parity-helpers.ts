import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect } from 'vitest';
import { createDocument as createDocumentRaw } from '$lib/data/document-ops';
import type { ActorId } from '$lib/data/types';
import { TEST_ORIGIN, transactWithOrigin } from '$lib/mutation-origin';

export const human: ActorId = { kind: 'human', userId: 'brylie' };

// The server-side workspace contexts used by the cross-space tests have
// projection observers attached. Keep direct fixture mutations explicit so
// they exercise the same origin contract as every other test write.
export function createDocument(
	doc: Parameters<typeof createDocumentRaw>[0],
	input: Parameters<typeof createDocumentRaw>[1]
) {
	return transactWithOrigin(doc, TEST_ORIGIN, () => createDocumentRaw(doc, input));
}

// A generic assertion-sugar helper: T is used only once in the
// signature (this rule's own "replace with the constraint" fix would
// collapse every call site's return type to `unknown`), but that single
// use is exactly the point — dozens of call sites below rely on
// parseMcpText<SomeShape>(result) inferring their own precise return
// type instead of each repeating its own `as SomeShape` cast.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function parseMcpText<T = unknown>(result: unknown): T {
	const r = result as { content?: { text?: string }[]; isError?: boolean };
	if (r.isError) {
		const text = r.content?.[0]?.text ?? 'Unknown error';
		throw new Error(`MCP Error: ${text}`);
	}
	const text = r.content?.[0]?.text ?? '';
	return text ? (JSON.parse(text) as T) : (null as unknown as T);
}

export function getResultText(result: unknown): string {
	const r = result as { content?: { text?: string }[] };
	return r.content?.[0]?.text ?? '';
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * For a `uiAdapterBindings` entry the UI reaches by mutating its own Yjs doc
 * directly rather than calling a service function (see audit-coverage.md) —
 * a real route/action can't be driven for these the way the other entries
 * are, so the harness-driven half of this test instead mirrors the exact
 * data-layer call the bound `.svelte` file performs. That still can't catch
 * the file's own event handler no longer actually calling it (issue #213's
 * broader concern, and Qodo review finding 3 on PR #256) — a real DOM
 * interaction is Tier B's job, not Tier A's. This is the static half: a
 * source-text check that the bound file both imports `functionName` from
 * `importedFromModule` and has a call-shaped `functionName(` occurrence
 * distinct from the import statement itself.
 */
export function assertRouteFileWiresCall(
	routeFile: string,
	functionName: string,
	importedFromModule: string
): void {
	const source = readFileSync(resolve(process.cwd(), routeFile), 'utf-8');
	const importPattern = new RegExp(
		`import\\s*\\{[^}]*\\b${functionName}\\b[^}]*\\}\\s*from\\s*['"]${escapeRegExp(importedFromModule)}['"]`
	);
	expect(source, `${routeFile} should import ${functionName} from ${importedFromModule}`).toMatch(
		importPattern
	);
	expect(source, `${routeFile} should call ${functionName}(...)`).toContain(`${functionName}(`);
}
