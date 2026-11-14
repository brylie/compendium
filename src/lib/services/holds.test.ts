import { describe, expect, it, vi } from 'vitest';
import { createDocument, createRecord, holdRecords, releaseRecords } from './index';
import { resolveRequestContext } from '$lib/server/request-context';
import { createToken } from '$lib/server/token-store';
import { queryAuditLog } from '$lib/server/audit';
import { aggregateHolds } from '$lib/server/holds';
import { resolveRecordWorkspaceContext } from './permissions';
import type { ActorId } from '$lib/data/types';

const human: ActorId = { kind: 'human', userId: 'local' };

function fixture() {
	const context = resolveRequestContext(human);
	const allowed = createDocument(context, { title: 'Allowed' });
	const forbidden = createDocument(context, { title: 'Secret title' });
	const block = createRecord(context, { parentId: allowed.id, blockType: 'paragraph' });
	const secret = createRecord(context, { parentId: forbidden.id, blockType: 'paragraph' });
	const { record: token } = createToken({
		clientLabel: 'Hold safety agent',
		allowedDocumentIds: [allowed.id],
		allowedCollectionIds: []
	});
	return { context: resolveRequestContext(token), token, allowed, forbidden, block, secret };
}

describe('hold authorization and denial auditing', () => {
	it('partially grants a mixed batch and audits each denied id once without content', () => {
		const { context, block, secret, forbidden } = fixture();
		const result = holdRecords(context, [block.id, secret.id, secret.id, 'missing-record']);
		expect(result).toEqual({
			granted: [block.id],
			denied: [secret.id, secret.id, 'missing-record']
		});
		const denials = queryAuditLog().filter((e) => e.action === 'hold_records_denied');
		expect(denials).toHaveLength(2);
		expect(denials.map((e) => e.targetRecordId)).toEqual(
			expect.arrayContaining([forbidden.id, 'missing-record'])
		);
		for (const entry of denials) {
			expect(entry.actor).toEqual({
				kind: 'human-via-client',
				userId: 'local',
				client: 'Hold safety agent'
			});
			expect(entry.diff).toBeUndefined();
			expect(JSON.stringify(entry)).not.toContain('Secret title');
		}
		expect(queryAuditLog().find((e) => e.action === 'hold_records')?.diff).toEqual(result);
		expect(
			aggregateHolds(resolveRecordWorkspaceContext(context, secret.id).awareness).has(secret.id)
		).toBe(false);
	});

	it('audits unauthorized busy records but does not label authorized contention as permission denial', () => {
		const { context, block, secret, forbidden } = fixture();
		const { record: holder } = createToken({
			clientLabel: 'Other holder',
			allowedDocumentIds: [block.parentId, secret.parentId],
			allowedCollectionIds: []
		});
		holdRecords(resolveRequestContext(holder), [block.id, secret.id]);
		const before = queryAuditLog().filter((e) => e.action === 'hold_records_denied').length;
		expect(holdRecords(context, [block.id, secret.id])).toEqual({
			granted: [],
			denied: [block.id, secret.id]
		});
		const denials = queryAuditLog().filter((e) => e.action === 'hold_records_denied');
		expect(denials).toHaveLength(before + 1);
		expect(denials[0].targetRecordId).toBe(forbidden.id);
		for (const record of [block, secret]) {
			const holds = aggregateHolds(resolveRecordWorkspaceContext(context, record.id).awareness);
			expect(holds.get(record.id)).toEqual({
				kind: 'human-via-client',
				userId: 'local',
				client: holder.clientLabel
			});
		}
	});

	it('removes a revoked existing hold even when the next request names a different record in that shard', () => {
		const { context, token, block } = fixture();
		const other = createRecord(resolveRequestContext(human), {
			parentId: block.parentId,
			blockType: 'paragraph'
		});
		holdRecords(context, [block.id]);
		token.allowedDocumentIds = [];
		expect(holdRecords(context, [other.id])).toEqual({ granted: [], denied: [other.id] });
		const holds = aggregateHolds(resolveRecordWorkspaceContext(context, block.id).awareness);
		expect(holds.has(block.id)).toBe(false);
		expect(holds.has(other.id)).toBe(false);
	});

	it.each(['token', 'human'] as const)(
		'propagates unexpected workspace errors for a %s caller',
		(callerKind) => {
			const { context, block } = fixture();
			const failure = new Error('workspace unavailable');
			const spy = vi.spyOn(context.workspaceStore, 'resolve').mockImplementation(() => {
				throw failure;
			});
			try {
				expect(() =>
					holdRecords(callerKind === 'human' ? { ...context, caller: human } : context, [block.id])
				).toThrow(failure);
			} finally {
				spy.mockRestore();
				releaseRecords(context, [block.id]);
			}
		}
	);
});
