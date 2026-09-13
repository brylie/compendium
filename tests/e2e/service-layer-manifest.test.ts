import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from './harness';
import { queryAuditLog } from '$lib/server/audit';
import { serviceModules, serviceSurfaces } from '$lib/services/manifest';
import { human } from './mcp-parity-helpers';

describe('Service Layer Manifest Wiring', () => {
	let harness: TestHarness;

	beforeEach(async () => {
		harness = await createTestHarness();
	});

	afterEach(async () => {
		await harness?.cleanup();
	});

	it('10. Service layer manifest wiring check: validates all MCP tools and UI surface side effects', async () => {
		const methods = Object.keys(serviceSurfaces) as (keyof typeof serviceSurfaces)[];
		expect(methods.length).toBeGreaterThanOrEqual(15);

		// 1. Verify all mcp: true entries are wired and discoverable over MCP transport
		const { token } = harness.createToken({
			clientLabel: 'Manifest Inspector',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});
		const mcp = await harness.getMcpClient(token);
		const toolList = await mcp.listTools();
		const toolNames = toolList.tools.map((t) => t.name);

		for (const method of methods) {
			const surface = serviceSurfaces[method];
			if (surface.mcp) {
				expect(surface.mcpToolName).toBeDefined();
				expect(toolNames).toContain(surface.mcpToolName);
			}
		}

		// 2. Parametrize and execute every ui: true entry, asserting the required service side-effect occurred
		const testDoc = serviceModules.documents.createDocument(human, {
			title: 'Manifest Wiring Doc',
			createInitialBlock: true
		});
		const testBlock = serviceModules.records.createRecord(human, {
			parentId: testDoc.id,
			blockType: 'paragraph'
		});
		const testCol = serviceModules.collections.createCollection(human, {
			title: 'Manifest Wiring Col',
			schema: [{ key: 'status', label: 'Status', type: 'select' }]
		});

		for (const method of methods) {
			const surface = serviceSurfaces[method];
			if (!surface.ui) continue;

			switch (method) {
				case 'documents.createDocument': {
					const d = serviceModules.documents.createDocument(human, { title: 'Wiring Sub' });
					expect(d.id).toBeDefined();
					const log = queryAuditLog().filter((e) => e.targetRecordId === d.id);
					expect(log.some((e) => e.action === 'create_document')).toBe(true);
					break;
				}
				case 'documents.updateDocumentTitle': {
					serviceModules.documents.updateDocumentTitle(human, testDoc.id, 'Renamed Doc');
					const log = queryAuditLog().filter((e) => e.targetRecordId === testDoc.id);
					expect(log.some((e) => e.action === 'update_document_title')).toBe(true);
					break;
				}
				case 'documents.listDocuments': {
					const list = serviceModules.documents.listDocuments(human);
					expect(list.some((d) => d.id === testDoc.id)).toBe(true);
					break;
				}
				case 'documents.listBacklinks': {
					const linked = serviceModules.documents.createDocument(human, {
						title: 'Links To Wiring Doc'
					});
					serviceModules.records.createRecord(human, {
						parentId: linked.id,
						blockType: 'page_link',
						referencedRecordId: testDoc.id
					});
					const backlinks = serviceModules.documents.listBacklinks(human, testDoc.id);
					expect(backlinks.some((b) => b.sourceDocumentId === linked.id)).toBe(true);
					const log = queryAuditLog().filter((e) => e.targetRecordId === testDoc.id);
					expect(log.some((e) => e.action === 'list_backlinks')).toBe(true);
					break;
				}
				case 'documents.deleteDocument': {
					const toDelete = serviceModules.documents.createDocument(human, { title: 'To Delete' });
					serviceModules.documents.deleteDocument(human, toDelete.id);
					const log = queryAuditLog().filter((e) => e.targetRecordId === toDelete.id);
					expect(log.some((e) => e.action === 'delete_document')).toBe(true);
					break;
				}
				case 'records.createRecord': {
					const r = serviceModules.records.createRecord(human, {
						parentId: testDoc.id,
						blockType: 'paragraph'
					});
					const log = queryAuditLog().filter((e) => e.targetRecordId === r.id);
					expect(log.some((e) => e.action === 'create_record')).toBe(true);
					break;
				}
				case 'records.writeRecord': {
					serviceModules.records.writeRecord(human, testBlock.id, {
						markdown: 'Updated text via human'
					});
					const log = queryAuditLog().filter((e) => e.targetRecordId === testBlock.id);
					expect(log.some((e) => e.action === 'write_record')).toBe(true);
					break;
				}
				case 'records.deleteRecord': {
					const r = serviceModules.records.createRecord(human, {
						parentId: testDoc.id,
						blockType: 'paragraph'
					});
					serviceModules.records.deleteRecord(human, r.id);
					const log = queryAuditLog().filter((e) => e.targetRecordId === r.id);
					expect(log.some((e) => e.action === 'delete_record')).toBe(true);
					break;
				}
				case 'collections.createCollection': {
					const col = serviceModules.collections.createCollection(human, {
						title: 'Wiring Sub Col',
						schema: []
					});
					expect(col.id).toBeDefined();
					const log = queryAuditLog().filter((e) => e.targetRecordId === col.id);
					expect(log.some((e) => e.action === 'create_collection')).toBe(true);
					break;
				}
				case 'collections.listCollections': {
					const list = serviceModules.collections.listCollections(human);
					expect(list.some((c) => c.id === testCol.id)).toBe(true);
					break;
				}
				case 'collections.updateCollectionTitle': {
					serviceModules.collections.updateCollectionTitle(human, testCol.id, 'Renamed Col');
					const log = queryAuditLog().filter((e) => e.targetRecordId === testCol.id);
					expect(log.some((e) => e.action === 'update_collection_title')).toBe(true);
					break;
				}
				case 'collections.deleteCollection': {
					const col = serviceModules.collections.createCollection(human, {
						title: 'To Delete Col',
						schema: []
					});
					serviceModules.collections.deleteCollection(human, col.id);
					const log = queryAuditLog().filter((e) => e.targetRecordId === col.id);
					expect(log.some((e) => e.action === 'delete_collection')).toBe(true);
					break;
				}
				case 'spaces.createSpace': {
					const space = serviceModules.spaces.createSpace(human, 'Manifest Wiring Space');
					expect(space.id).toBeDefined();
					const log = queryAuditLog().filter((e) => e.targetRecordId === space.id);
					expect(log.some((e) => e.action === 'create_space')).toBe(true);
					break;
				}
				case 'spaces.listSpaces': {
					const spaces = serviceModules.spaces.listSpaces();
					expect(Array.isArray(spaces)).toBe(true);
					break;
				}
				case 'tokens.createToken': {
					const { record } = serviceModules.tokens.createToken(human, {
						clientLabel: 'Manifest Wiring Token',
						allowedDocumentIds: [],
						allowedCollectionIds: [],
						allowedSpaceIds: []
					});
					const log = queryAuditLog().filter((e) => e.targetRecordId === record.tokenHash);
					expect(log.some((e) => e.action === 'create_token')).toBe(true);
					break;
				}
				case 'tokens.revokeToken': {
					const { record } = serviceModules.tokens.createToken(human, {
						clientLabel: 'Manifest Wiring Token To Revoke',
						allowedDocumentIds: [],
						allowedCollectionIds: [],
						allowedSpaceIds: []
					});
					serviceModules.tokens.revokeToken(human, record.tokenHash);
					const log = queryAuditLog().filter((e) => e.targetRecordId === record.tokenHash);
					expect(log.some((e) => e.action === 'revoke_token')).toBe(true);
					break;
				}
				case 'tokens.listTokens': {
					const tokens = serviceModules.tokens.listTokens();
					expect(Array.isArray(tokens)).toBe(true);
					break;
				}
				case 'audit.listAuditHistory': {
					const history = serviceModules.audit.listAuditHistory();
					expect(history.length).toBeGreaterThan(0);
					break;
				}
				case 'export.exportWorkspace': {
					const res = serviceModules.export.exportWorkspace(human);
					expect(res.manifest).toBeDefined();
					expect(res.zipBuffer).toBeDefined();
					break;
				}
				case 'export.exportDocument': {
					const docs = serviceModules.documents.listDocuments(human);
					if (docs.length > 0) {
						const res = serviceModules.export.exportDocument(human, docs[0].id);
						expect(res.markdown).toBeDefined();
					}
					break;
				}
				case 'export.exportCollection': {
					const cols = serviceModules.collections.listCollections(human);
					if (cols.length > 0) {
						const res = serviceModules.export.exportCollection(human, cols[0].id);
						expect(res.recordsCsv).toBeDefined();
					}
					break;
				}
				case 'export.getMirrorConfig': {
					const config = serviceModules.export.getMirrorConfig();
					expect(config).toBeDefined();
					break;
				}
				case 'export.updateMirrorConfig': {
					const updated = serviceModules.export.updateMirrorConfig(human, {
						enabled: false
					});
					expect(updated.enabled).toBe(false);
					break;
				}
				case 'export.syncMarkdownMirror': {
					const res = serviceModules.export.syncMarkdownMirror();
					expect(res).toHaveProperty('synced');
					break;
				}
				default:
					throw new Error(`Unhandled ui: true manifest entry: ${String(method)}`);
			}
		}
	});
});
