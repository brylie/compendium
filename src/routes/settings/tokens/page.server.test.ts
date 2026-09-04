import { describe, expect, it } from 'vitest';
import { load, actions } from './+page.server';
import { createCollection, createDocument } from '$lib/services';
import { CURRENT_USER } from '$lib/server/current-user';
import { resolveRequestContext } from '$lib/server/request-context';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { createSpace } from '$lib/server/catalog';
import { listTokens } from '$lib/mcp/tokens';

function loadEvent(): Parameters<typeof load>[0] {
	return { locals: { requestContext: resolveRequestContext() } } as unknown as Parameters<
		typeof load
	>[0];
}

function formEvent(
	fields: Record<string, string | string[]>
): Parameters<typeof actions.create>[0] {
	const formData = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		if (Array.isArray(value)) value.forEach((v) => formData.append(key, v));
		else formData.set(key, value);
	}
	return {
		request: { formData: async () => formData },
		locals: { requestContext: resolveRequestContext() }
	} as unknown as Parameters<typeof actions.create>[0];
}

describe('routes/settings/tokens/+page.server', () => {
	it('load() lists tokens, documents, and collections', () => {
		createDocument(CURRENT_USER, { title: 'Doc for tokens page' });

		const result = load(loadEvent()) as unknown as {
			documents: { title: string }[];
			tokens: unknown[];
		};

		expect(result.documents.some((d) => d.title === 'Doc for tokens page')).toBe(true);
		expect(Array.isArray(result.tokens)).toBe(true);
	});

	it('load() lists Documents and Collections created via the service layer, each in their own real shard (#188)', () => {
		const shardedDoc = createDocument(CURRENT_USER, { title: 'Sharded Doc for tokens page' });
		const shardedCol = createCollection(CURRENT_USER, {
			title: 'Sharded Collection for tokens page',
			schema: []
		});

		const result = load(loadEvent()) as unknown as {
			documents: { id: string; title: string }[];
			collections: { id: string; title: string }[];
		};

		expect(result.documents.some((d) => d.id === shardedDoc.id)).toBe(true);
		expect(result.collections.some((c) => c.id === shardedCol.id)).toBe(true);
	});

	it('create action fails on a blank clientLabel', async () => {
		const result = await actions.create(formEvent({ clientLabel: '  ' }));
		expect(result).toEqual({ status: 400, data: { error: 'Client label is required' } });
	});

	it('create action mints a scoped token and logs the grant', async () => {
		const docMeta = createDocument(CURRENT_USER, { title: 'Scoped Doc' });

		const result = (await actions.create(
			formEvent({ clientLabel: 'Test Client', documentIds: [docMeta.id] })
		)) as unknown as { createdToken: string; clientLabel: string };

		expect(result.createdToken).toMatch(/^as_/);
		expect(result.clientLabel).toBe('Test Client');
		expect(listTokens().some((t) => t.clientLabel === 'Test Client')).toBe(true);
	});

	it('create action rejects a spaceId that does not belong to this workspace (#141 CodeRabbit)', async () => {
		const result = await actions.create(
			formEvent({ clientLabel: 'Space Spoofer', spaceIds: ['not-a-real-space-id'] })
		);
		expect(result).toEqual({ status: 400, data: { error: 'Invalid Space selection' } });
		expect(listTokens().some((t) => t.clientLabel === 'Space Spoofer')).toBe(false);
	});

	it('create action mints a token scoped to a real Space', async () => {
		const { workspaceId } = resolveWorkspaceContext();
		const space = createSpace(workspaceId, 'Real Space');

		const result = (await actions.create(
			formEvent({ clientLabel: 'Space Grant Client', spaceIds: [space.id] })
		)) as unknown as { createdToken: string };

		expect(result.createdToken).toMatch(/^as_/);
		const record = listTokens().find((t) => t.clientLabel === 'Space Grant Client');
		expect(record?.allowedSpaceIds).toEqual([space.id]);
	});

	it('create action rejects a documentId that does not exist (issue #62)', async () => {
		const result = await actions.create(
			formEvent({ clientLabel: 'Document Spoofer', documentIds: ['not-a-real-document-id'] })
		);
		expect(result).toEqual({ status: 400, data: { error: 'Invalid Document selection' } });
		expect(listTokens().some((t) => t.clientLabel === 'Document Spoofer')).toBe(false);
	});

	it('create action rejects a collectionId that does not exist (issue #62)', async () => {
		const result = await actions.create(
			formEvent({ clientLabel: 'Collection Spoofer', collectionIds: ['not-a-real-collection-id'] })
		);
		expect(result).toEqual({ status: 400, data: { error: 'Invalid Collection selection' } });
		expect(listTokens().some((t) => t.clientLabel === 'Collection Spoofer')).toBe(false);
	});

	it('revoke action fails without a tokenHash', async () => {
		const result = await actions.revoke(formEvent({}));
		expect(result).toEqual({ status: 400, data: { error: 'Missing token' } });
	});

	it('revoke action revokes an existing token', async () => {
		await actions.create(formEvent({ clientLabel: 'To Revoke' }));
		const tokenRecord = listTokens().find((t) => t.clientLabel === 'To Revoke')!;

		const result = await actions.revoke(formEvent({ tokenHash: tokenRecord.tokenHash }));

		expect(result).toEqual({ revoked: true });
		expect(
			listTokens().find((t) => t.tokenHash === tokenRecord.tokenHash)?.revokedAt
		).toBeDefined();
	});
});
