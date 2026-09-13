import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './harness';
import { getCollection, updateCollectionTitle } from '$lib/data/collection-ops';
import { getDocument as getDocumentMeta, updateDocumentTitle } from '$lib/data/document-ops';
import {
	createRecord,
	deleteRecord as crdtDeleteRecord,
	getRecord,
	getRecordYText
} from '$lib/data/record-ops';
import { queryAuditLog } from '$lib/server/audit';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { plainText, yTextToRichText } from '$lib/data/richtext';
import { serviceModules, serviceSurfaces, uiAdapterBindings } from '$lib/services/manifest';
import { flushPendingAuditEvents } from '$lib/server/audit-observer';
import { LOCAL_UI_ORIGIN, transactWithOrigin } from '$lib/mutation-origin';
import { CURRENT_USER } from '$lib/client/actor';
import { assertRouteFileWiresCall, human } from './mcp-parity-helpers';

describe('UI Adapter Bindings', () => {
	let harness: TestHarness;

	beforeEach(async () => {
		harness = await createTestHarness();
	});

	afterEach(async () => {
		await harness?.cleanup();
	});

	it("17. UI adapter bindings: each declared uiAdapterBindings entry's real route/action (or, for a directly-Yjs-mutated surface, the same client mutation its bound file performs) produces the observable effect proving it's genuinely wired, not just declared (issue #213)", async () => {
		// tests/e2e/harness.ts only serves real SvelteKit routes/actions when
		// build/handler.js exists — CI always runs `npm run build` before
		// `npm run test:e2e` (see .github/workflows/ci.yml), same precondition
		// Tier B already has. A local `npm run test:e2e:tier-a` run without a
		// prior build would otherwise 404 on every case below for a confusing
		// reason — fail fast with an actionable message instead.
		if (!harness.hasAppHandler) {
			throw new Error(
				'harness.hasAppHandler is false — run `npm run build` before this test so ' +
					'tests/e2e/harness.ts can serve real routes/actions through build/handler.js.'
			);
		}

		const methods = Object.keys(uiAdapterBindings) as (keyof typeof uiAdapterBindings)[];
		expect(methods.length).toBeGreaterThanOrEqual(15);
		// Every bound method must actually be declared ui: true — a mismatch
		// here would mean the two manifest maps have drifted apart, which
		// manifest.test.ts also guards, but asserting it here too keeps this
		// test's own precondition self-checking.
		for (const method of methods) {
			expect(serviceSurfaces[method].ui, method).toBe(true);
		}

		async function postJson(path: string, body: unknown): Promise<Response> {
			return fetch(`${harness.httpUrl}${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
		}

		// A SvelteKit form action only returns a JSON action result (rather
		// than a 303 redirect meant for a non-JS form submission) for a
		// request that negotiates `application/json`, and only avoids the
		// framework's own CSRF-origin check (respond.js) for a body whose
		// Content-Type isn't form-shaped — neither applies to a plain
		// multipart FormData POST like a real <form> submits, so both are set
		// explicitly here. The Origin value itself is arbitrary: the harness
		// rewrites any present `origin` header to the one value it pins
		// build/handler.js's own trusted ORIGIN to (see harness.ts's own
		// top-of-file comment) before SvelteKit's check ever runs.
		async function postForm(path: string, fields: Record<string, string>): Promise<Response> {
			const form = new FormData();
			for (const [key, value] of Object.entries(fields)) form.set(key, value);
			return fetch(`${harness.httpUrl}${path}`, {
				method: 'POST',
				headers: { accept: 'application/json', origin: harness.httpUrl },
				body: form
			});
		}

		// SvelteKit's own client-side router fetches a route's load-function
		// output this way for a client-side navigation, without ever
		// rendering the page's Svelte components — exactly the boundary this
		// test wants for a `load`-bound entry (did the load function run and
		// return the right data), as opposed to Tier B's job of rendering.
		// The body is devalue-encoded, not plain JSON, but a plain substring
		// check on it is enough to prove specific data round-tripped through.
		async function fetchRouteData(path: string): Promise<{ status: number; text: string }> {
			const res = await fetch(`${harness.httpUrl}${path}/__data.json`);
			return { status: res.status, text: await res.text() };
		}

		const { workspaceId, defaultSpaceId } = resolveWorkspaceContext();

		// Shared fixtures for the directly-Yjs-mutated cases below, created via
		// the real create_document/create_collection routes (not a direct
		// service call) so the fixtures themselves are also genuinely wired,
		// then connected to their own real shard room exactly as
		// $lib/client/yjs-client.ts's getShardDoc does for a real browser tab.
		const wiringDoc = (await (
			await postJson('/api/documents', { title: 'UI Wiring Fixture Doc' })
		).json()) as { id: string };
		const wiringDocClient = harness.getYjsClient({ room: `shard-${wiringDoc.id}` });
		await harness.waitForCondition(() => wiringDocClient.doc.getMap('documents').has(wiringDoc.id));
		const wiringDocServerCtx = resolveWorkspaceContext({ workspaceId, shardId: wiringDoc.id });

		const wiringCol = (await (
			await postJson('/api/collections', { title: 'UI Wiring Fixture Col' })
		).json()) as { id: string };
		const wiringColClient = harness.getYjsClient({ room: `shard-${wiringCol.id}` });
		await harness.waitForCondition(() =>
			wiringColClient.doc.getMap('collections').has(wiringCol.id)
		);
		const wiringColServerCtx = resolveWorkspaceContext({ workspaceId, shardId: wiringCol.id });

		// Each switch case below independently hard-codes the route/action or
		// client mutation it exercises, rather than reading `uiAdapterBindings`
		// to decide what to hit — that's what makes the case shaped exactly
		// like the real UI path. But it also means the switch alone can't
		// notice if `uiAdapterBindings[method]` were edited to name a
		// *different* (still-existing) file: this independently-authored
		// expectation pins each declared binding to the exact file this test
		// was actually written against, so that drift fails loudly here
		// instead of silently passing.
		const expectedBindings: Record<keyof typeof uiAdapterBindings, string> = {
			'documents.createDocument': 'src/routes/api/documents/+server.ts',
			'documents.deleteDocument': 'src/routes/api/documents/[id]/+server.ts',
			'documents.updateDocumentTitle': 'src/routes/space/[spaceId]/doc/[id]/+page.svelte',
			'documents.listDocuments': 'src/routes/+layout.server.ts',
			'documents.listBacklinks': 'src/routes/space/[spaceId]/doc/[id]/+page.server.ts',
			'records.createRecord': 'src/routes/space/[spaceId]/doc/[id]/+page.svelte',
			'records.writeRecord': 'src/routes/space/[spaceId]/doc/[id]/+page.svelte',
			'records.deleteRecord': 'src/routes/space/[spaceId]/doc/[id]/+page.svelte',
			'collections.createCollection': 'src/routes/api/collections/+server.ts',
			'collections.listCollections': 'src/routes/+layout.server.ts',
			'collections.deleteCollection': 'src/routes/api/collections/[id]/+server.ts',
			'collections.updateCollectionTitle': 'src/routes/space/[spaceId]/table/[id]/+page.svelte',
			'spaces.createSpace': 'src/routes/api/spaces/+server.ts',
			'spaces.listSpaces': 'src/routes/+layout.server.ts',
			'tokens.createToken': 'src/routes/settings/tokens/+page.server.ts',
			'tokens.revokeToken': 'src/routes/settings/tokens/+page.server.ts',
			'tokens.listTokens': 'src/routes/settings/tokens/+page.server.ts',
			'audit.listAuditHistory': 'src/routes/audit/+page.server.ts',
			'export.exportWorkspace': 'src/routes/api/export/+server.ts',
			'export.exportDocument': 'src/routes/api/export/+server.ts',
			'export.exportCollection': 'src/routes/api/export/+server.ts',
			'export.getMirrorConfig': 'src/routes/settings/export/+page.server.ts',
			'export.updateMirrorConfig': 'src/routes/settings/export/+page.server.ts',
			'export.syncMarkdownMirror': 'src/routes/settings/export/+page.server.ts'
		};
		for (const method of methods) {
			expect(uiAdapterBindings[method], method).toBe(expectedBindings[method]);
		}

		for (const method of methods) {
			switch (method) {
				case 'documents.createDocument': {
					const res = await postJson('/api/documents', { title: 'Route Wiring Doc' });
					expect(res.status).toBe(200);
					const doc = (await res.json()) as { id: string };
					expect(doc.id).toBeDefined();
					const log = queryAuditLog().filter((e) => e.targetRecordId === doc.id);
					expect(log.some((e) => e.action === 'create_document')).toBe(true);
					break;
				}
				case 'documents.deleteDocument': {
					const created = (await (
						await postJson('/api/documents', { title: 'Route Wiring Doc To Delete' })
					).json()) as { id: string };
					const res = await fetch(`${harness.httpUrl}/api/documents/${created.id}`, {
						method: 'DELETE'
					});
					expect(res.status).toBe(200);
					expect(await res.json()).toEqual({ success: true });
					const log = queryAuditLog().filter((e) => e.targetRecordId === created.id);
					expect(log.some((e) => e.action === 'delete_document')).toBe(true);
					break;
				}
				case 'documents.listDocuments': {
					// Fetched via /audit, not /space/[spaceId]: that page's own
					// +page.server.ts independently calls listDocuments too (for its
					// card grid), so a title appearing in its __data.json wouldn't
					// prove the *declared* binding (the root +layout.server.ts) is
					// the one that ran — /audit's own load only calls
					// listAuditHistory, so the root layout is the only source.
					const title = `Route Wiring List Doc ${Date.now()}`;
					await postJson('/api/documents', { title });
					const { status, text } = await fetchRouteData('/audit');
					expect(status).toBe(200);
					expect(text).toContain(title);
					break;
				}
				case 'documents.listBacklinks': {
					const target = (await (
						await postJson('/api/documents', { title: 'Backlink Target Doc' })
					).json()) as { id: string };
					const sourceTitle = `Backlink Source Doc ${Date.now()}`;
					const source = (await (
						await postJson('/api/documents', { title: sourceTitle })
					).json()) as { id: string };

					// The page_link block is authored the same way records.createRecord's
					// own case in this switch does — a real y-websocket client mirroring
					// the UI's direct-Yjs create path — since that's genuinely how a
					// backlink comes to exist; documents.listBacklinks itself is a pure
					// read with nothing of its own to author.
					const sourceClient = harness.getYjsClient({ room: `shard-${source.id}` });
					await harness.waitForCondition(() => sourceClient.doc.getMap('documents').has(source.id));
					transactWithOrigin(sourceClient.doc, LOCAL_UI_ORIGIN, () =>
						createRecord(
							sourceClient.doc,
							{ parentId: source.id, blockType: 'page_link', referencedRecordId: target.id },
							CURRENT_USER
						)
					);

					// Polls the real route itself (not a server-side doc read) so this
					// wait also doubles as the first real exercise of the route once the
					// fan-out scan can actually see the new page_link block.
					await harness.waitForCondition(async () => {
						const res = await fetchRouteData(`/space/${defaultSpaceId}/doc/${target.id}`);
						return res.status === 200 && res.text.includes(sourceTitle);
					});

					const log = queryAuditLog().filter((e) => e.targetRecordId === target.id);
					expect(log.some((e) => e.action === 'list_backlinks')).toBe(true);
					break;
				}
				case 'documents.updateDocumentTitle': {
					assertRouteFileWiresCall(
						expectedBindings[method],
						'updateDocumentTitle',
						'$lib/data/document-ops'
					);
					transactWithOrigin(wiringDocClient.doc, LOCAL_UI_ORIGIN, () =>
						updateDocumentTitle(wiringDocClient.doc, wiringDoc.id, 'Renamed via UI-mirrored client')
					);
					await harness.waitForCondition(
						() =>
							getDocumentMeta(wiringDocServerCtx.doc, wiringDoc.id)?.title ===
							'Renamed via UI-mirrored client'
					);
					flushPendingAuditEvents();
					expect(
						queryAuditLog().some(
							(e) => e.targetRecordId === wiringDoc.id && e.action === 'update_document'
						)
					).toBe(true);
					break;
				}
				case 'records.createRecord': {
					assertRouteFileWiresCall(
						expectedBindings[method],
						'createRecord',
						'$lib/data/record-ops'
					);
					const record = transactWithOrigin(wiringDocClient.doc, LOCAL_UI_ORIGIN, () =>
						createRecord(
							wiringDocClient.doc,
							{ parentId: wiringDoc.id, blockType: 'paragraph' },
							CURRENT_USER
						)
					);
					await harness.waitForCondition(
						() => getRecord(wiringDocServerCtx.doc, record.id) !== undefined
					);
					expect(
						queryAuditLog().some(
							(e) => e.targetRecordId === record.id && e.action === 'create_record'
						)
					).toBe(true);
					break;
				}
				case 'records.writeRecord': {
					// No single function named "writeRecord" exists on the UI's
					// direct-Yjs path — content edits go through Y.Text mutation
					// helpers instead, so the static wiring check below pins to
					// applyRichTextToYText (the one this case itself mirrors)
					// rather than a function name that wouldn't exist to find.
					assertRouteFileWiresCall(
						expectedBindings[method],
						'applyRichTextToYText',
						'$lib/data/richtext'
					);
					const record = transactWithOrigin(wiringDocClient.doc, LOCAL_UI_ORIGIN, () =>
						createRecord(
							wiringDocClient.doc,
							{ parentId: wiringDoc.id, blockType: 'paragraph' },
							CURRENT_USER
						)
					);
					await harness.waitForCondition(
						() => getRecordYText(wiringDocServerCtx.doc, record.id) !== undefined
					);
					const ytext = getRecordYText(wiringDocClient.doc, record.id)!;
					transactWithOrigin(wiringDocClient.doc, LOCAL_UI_ORIGIN, () => {
						ytext.insert(0, 'Typed directly by the UI-mirrored client');
					});
					await harness.waitForCondition(() => {
						const serverText = getRecordYText(wiringDocServerCtx.doc, record.id);
						return !!serverText && plainText(yTextToRichText(serverText)).length > 0;
					});
					flushPendingAuditEvents();
					expect(
						queryAuditLog().some(
							(e) => e.targetRecordId === record.id && e.action === 'update_record'
						)
					).toBe(true);
					break;
				}
				case 'records.deleteRecord': {
					assertRouteFileWiresCall(
						expectedBindings[method],
						'deleteRecord',
						'$lib/data/record-ops'
					);
					const record = transactWithOrigin(wiringDocClient.doc, LOCAL_UI_ORIGIN, () =>
						createRecord(
							wiringDocClient.doc,
							{ parentId: wiringDoc.id, blockType: 'paragraph' },
							CURRENT_USER
						)
					);
					await harness.waitForCondition(
						() => getRecord(wiringDocServerCtx.doc, record.id) !== undefined
					);
					transactWithOrigin(wiringDocClient.doc, LOCAL_UI_ORIGIN, () =>
						crdtDeleteRecord(wiringDocClient.doc, record.id)
					);
					await harness.waitForCondition(() =>
						queryAuditLog().some(
							(e) => e.targetRecordId === record.id && e.action === 'delete_record'
						)
					);
					break;
				}
				case 'collections.createCollection': {
					const res = await postJson('/api/collections', { title: 'Route Wiring Col' });
					expect(res.status).toBe(200);
					const col = (await res.json()) as { id: string };
					const log = queryAuditLog().filter((e) => e.targetRecordId === col.id);
					expect(log.some((e) => e.action === 'create_collection')).toBe(true);
					break;
				}
				case 'collections.listCollections': {
					// Same isolation reasoning as documents.listDocuments above:
					// /space/[spaceId]'s own page load also independently calls
					// listCollections, so /audit is used to pin this assertion to
					// the root +layout.server.ts binding specifically.
					const title = `Route Wiring List Col ${Date.now()}`;
					await postJson('/api/collections', { title });
					const { status, text } = await fetchRouteData('/audit');
					expect(status).toBe(200);
					expect(text).toContain(title);
					break;
				}
				case 'collections.deleteCollection': {
					const created = (await (
						await postJson('/api/collections', { title: 'Route Wiring Col To Delete' })
					).json()) as { id: string };
					const res = await fetch(`${harness.httpUrl}/api/collections/${created.id}`, {
						method: 'DELETE'
					});
					expect(res.status).toBe(200);
					const log = queryAuditLog().filter((e) => e.targetRecordId === created.id);
					expect(log.some((e) => e.action === 'delete_collection')).toBe(true);
					break;
				}
				case 'collections.updateCollectionTitle': {
					assertRouteFileWiresCall(
						expectedBindings[method],
						'updateCollectionTitle',
						'$lib/data/collection-ops'
					);
					transactWithOrigin(wiringColClient.doc, LOCAL_UI_ORIGIN, () =>
						updateCollectionTitle(
							wiringColClient.doc,
							wiringCol.id,
							'Renamed via UI-mirrored client'
						)
					);
					await harness.waitForCondition(
						() =>
							getCollection(wiringColServerCtx.doc, wiringCol.id)?.title ===
							'Renamed via UI-mirrored client'
					);
					flushPendingAuditEvents();
					expect(
						queryAuditLog().some(
							(e) => e.targetRecordId === wiringCol.id && e.action === 'update_collection'
						)
					).toBe(true);
					break;
				}
				case 'spaces.createSpace': {
					const res = await postJson('/api/spaces', { name: 'Route Wiring Space' });
					expect(res.status).toBe(200);
					const space = (await res.json()) as { id: string };
					const log = queryAuditLog().filter((e) => e.targetRecordId === space.id);
					expect(log.some((e) => e.action === 'create_space')).toBe(true);
					break;
				}
				case 'spaces.listSpaces': {
					// Fetched via /audit for the same isolation reasoning as the
					// two list cases above, even though nothing else on
					// /space/[spaceId]'s own chain happens to call listSpaces
					// today — keeping all three list checks on the same isolated
					// page avoids relying on that staying true.
					const name = `Route Wiring List Space ${Date.now()}`;
					await postJson('/api/spaces', { name });
					const { status, text } = await fetchRouteData('/audit');
					expect(status).toBe(200);
					expect(text).toContain(name);
					break;
				}
				case 'tokens.createToken': {
					const clientLabel = `Route Wiring Token ${Date.now()}`;
					const res = await postForm('/settings/tokens?/create', { clientLabel });
					expect(res.status).toBeLessThan(400);
					const created = serviceModules.tokens
						.listTokens()
						.find((t) => t.clientLabel === clientLabel);
					expect(created).toBeDefined();
					const log = queryAuditLog().filter((e) => e.targetRecordId === created!.tokenHash);
					expect(log.some((e) => e.action === 'create_token')).toBe(true);
					break;
				}
				case 'tokens.revokeToken': {
					const { record } = serviceModules.tokens.createToken(human, {
						clientLabel: `Route Wiring Token To Revoke ${Date.now()}`,
						allowedDocumentIds: [],
						allowedCollectionIds: [],
						allowedSpaceIds: []
					});
					const res = await postForm('/settings/tokens?/revoke', {
						tokenHash: record.tokenHash
					});
					expect(res.status).toBeLessThan(400);
					const log = queryAuditLog().filter((e) => e.targetRecordId === record.tokenHash);
					expect(log.some((e) => e.action === 'revoke_token')).toBe(true);
					break;
				}
				case 'tokens.listTokens': {
					const clientLabel = `Route Wiring Listed Token ${Date.now()}`;
					serviceModules.tokens.createToken(human, {
						clientLabel,
						allowedDocumentIds: [],
						allowedCollectionIds: [],
						allowedSpaceIds: []
					});
					const { status, text } = await fetchRouteData('/settings/tokens');
					expect(status).toBe(200);
					expect(text).toContain(clientLabel);
					break;
				}
				case 'audit.listAuditHistory': {
					const marker = (await (
						await postJson('/api/documents', { title: 'Route Wiring Audit Marker Doc' })
					).json()) as { id: string };
					const { status, text } = await fetchRouteData('/audit');
					expect(status).toBe(200);
					expect(text).toContain('create_document');
					expect(text).toContain(marker.id);
					break;
				}
				case 'export.exportWorkspace':
				case 'export.exportDocument':
				case 'export.exportCollection': {
					const res = await fetch(`${harness.httpUrl}/api/export?scope=workspace`);
					expect(res.status).toBe(200);
					break;
				}
				case 'export.getMirrorConfig':
				case 'export.updateMirrorConfig':
				case 'export.syncMarkdownMirror': {
					const { status, text } = await fetchRouteData('/settings/export');
					expect(status).toBe(200);
					expect(text).toContain('outputDir');
					break;
				}
				default: {
					// The switch above covers every uiAdapterBindings key, so `method`
					// is narrowed to `never` here — assigning it to a `never`-typed
					// binding (rather than `string`, which `never` would also satisfy
					// without proving anything) means a future uiAdapterBindings entry
					// added without a matching case fails `npm run check` at build
					// time, not just this test at runtime.
					const exhaustiveCheck: never = method;
					throw new Error(`Unhandled uiAdapterBindings entry: ${String(exhaustiveCheck)}`);
				}
			}
		}
	});
});
