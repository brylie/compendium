import { describe, expect, it } from 'vitest';
import { createSpace } from './spaces';
import { CURRENT_USER } from '$lib/server/current-user';
import { createToken } from '$lib/mcp/tokens';
import { queryAuditLog } from '$lib/server/audit';
import { isKnownSpace } from '$lib/server/catalog';
import { resolveWorkspaceContext } from '$lib/server/workspace-store';

describe('service layer: createSpace', () => {
	it('creates a Space in the caller workspace and logs an audit entry attributed to a human caller', () => {
		const space = createSpace(CURRENT_USER, 'Marketing');

		expect(space.name).toBe('Marketing');
		const { workspaceId } = resolveWorkspaceContext();
		expect(isKnownSpace(workspaceId, space.id)).toBe(true);

		const audits = queryAuditLog();
		expect(audits.some((a) => a.action === 'create_space' && a.targetRecordId === space.id)).toBe(
			true
		);
	});

	it('attributes the audit entry to the underlying human when the caller is a token', () => {
		const { record: tokenRecord } = createToken({
			clientLabel: 'Space Creator Bot',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});

		const space = createSpace(tokenRecord, 'Agent Space');

		const audits = queryAuditLog();
		const entry = audits.find((a) => a.action === 'create_space' && a.targetRecordId === space.id);
		expect(entry).toBeDefined();
		expect(entry?.actor).toMatchObject({ kind: 'human-via-client', client: 'Space Creator Bot' });
	});
});
