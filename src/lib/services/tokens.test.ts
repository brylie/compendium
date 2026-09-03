import { describe, expect, it } from 'vitest';
import { createToken, revokeToken, UnknownSpaceError } from './tokens';
import { CURRENT_USER } from '$lib/server/current-user';
import { createToken as createRawToken, listTokens } from '$lib/mcp/tokens';
import { queryAuditLog } from '$lib/server/audit';
import { createSpace } from '$lib/server/catalog';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';

describe('service layer: createToken (#188)', () => {
	it('mints a token and logs exactly one create_token audit entry attributed to a human caller', () => {
		const before = queryAuditLog().filter((a) => a.action === 'create_token').length;

		const { token, record } = createToken(CURRENT_USER, {
			clientLabel: 'Test Client',
			allowedDocumentIds: [],
			allowedCollectionIds: [],
			allowedSpaceIds: []
		});

		expect(token).toMatch(/^as_/);
		expect(listTokens().some((t) => t.tokenHash === record.tokenHash)).toBe(true);

		const entries = queryAuditLog().filter((a) => a.action === 'create_token');
		expect(entries).toHaveLength(before + 1);
		expect(entries[0].targetRecordId).toBe(record.tokenHash);
		expect(entries[0].actor).toMatchObject({ kind: 'human' });
	});

	it('attributes the audit entry to the underlying human when the caller is a token', () => {
		const { record: callerToken } = createRawToken({
			clientLabel: 'Token Minter Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});

		const { record } = createToken(callerToken, {
			clientLabel: 'Agent-Minted Client',
			allowedDocumentIds: [],
			allowedCollectionIds: [],
			allowedSpaceIds: []
		});

		const entry = queryAuditLog().find(
			(a) => a.action === 'create_token' && a.targetRecordId === record.tokenHash
		);
		expect(entry).toBeDefined();
		expect(entry?.actor).toMatchObject({ kind: 'human-via-client', client: 'Token Minter Bot' });
	});

	it('grants access to a real Space', () => {
		const { workspaceId } = resolveWorkspaceContext();
		const space = createSpace(workspaceId, 'Real Space For Token Test');

		const { record } = createToken(CURRENT_USER, {
			clientLabel: 'Space Grant Client',
			allowedDocumentIds: [],
			allowedCollectionIds: [],
			allowedSpaceIds: [space.id]
		});

		expect(record.allowedSpaceIds).toEqual([space.id]);
	});

	it('rejects a Space id that does not belong to this workspace, without persisting a token', () => {
		const before = listTokens().length;

		expect(() =>
			createToken(CURRENT_USER, {
				clientLabel: 'Space Spoofer',
				allowedDocumentIds: [],
				allowedCollectionIds: [],
				allowedSpaceIds: ['not-a-real-space-id']
			})
		).toThrow(UnknownSpaceError);

		expect(listTokens()).toHaveLength(before);
	});
});

describe('service layer: revokeToken (#188)', () => {
	it('revokes a token and logs exactly one revoke_token audit entry attributed to a human caller', () => {
		const { record } = createToken(CURRENT_USER, {
			clientLabel: 'To Revoke',
			allowedDocumentIds: [],
			allowedCollectionIds: [],
			allowedSpaceIds: []
		});
		const before = queryAuditLog().filter((a) => a.action === 'revoke_token').length;

		revokeToken(CURRENT_USER, record.tokenHash);

		expect(listTokens().find((t) => t.tokenHash === record.tokenHash)?.revokedAt).toBeDefined();
		const entries = queryAuditLog().filter((a) => a.action === 'revoke_token');
		expect(entries).toHaveLength(before + 1);
		expect(entries[0].targetRecordId).toBe(record.tokenHash);
		expect(entries[0].actor).toMatchObject({ kind: 'human' });
	});

	it('attributes the revoke audit entry to the underlying human when the caller is a token', () => {
		const { record: callerToken } = createRawToken({
			clientLabel: 'Token Revoker Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});
		const { record } = createToken(CURRENT_USER, {
			clientLabel: 'Revoked By Agent',
			allowedDocumentIds: [],
			allowedCollectionIds: [],
			allowedSpaceIds: []
		});

		revokeToken(callerToken, record.tokenHash);

		const entry = queryAuditLog().find(
			(a) => a.action === 'revoke_token' && a.targetRecordId === record.tokenHash
		);
		expect(entry).toBeDefined();
		expect(entry?.actor).toMatchObject({ kind: 'human-via-client', client: 'Token Revoker Bot' });
	});
});
