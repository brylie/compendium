import { describe, expect, it } from 'vitest';
import { load } from './+page.server';
import { logAudit } from '$lib/server/audit';

interface AuditLoadResult {
	actorKind: string;
	targetRecordId: string;
	entries: Array<{ actor: { kind: string }; targetRecordId?: string }>;
}

function urlEvent(searchParams: Record<string, string>): Parameters<typeof load>[0] {
	const url = new URL('http://localhost/audit');
	for (const [key, value] of Object.entries(searchParams)) url.searchParams.set(key, value);
	return { url } as Parameters<typeof load>[0];
}

describe('routes/audit/+page.server', () => {
	it('lists recent audit entries when no actorKind filter is given', () => {
		logAudit({ actor: { kind: 'human', userId: 'brylie' }, action: 'test_action' });
		const result = load(urlEvent({})) as unknown as AuditLoadResult;
		expect(result.actorKind).toBe('');
		expect(result.entries.length).toBeGreaterThan(0);
	});

	it('filters entries by actorKind when given', () => {
		logAudit({ actor: { kind: 'human', userId: 'brylie' }, action: 'human_action' });
		logAudit({ actor: { kind: 'agent', agentId: 'a1', name: 'Bot' }, action: 'agent_action' });

		const result = load(urlEvent({ actorKind: 'agent' })) as unknown as AuditLoadResult;

		expect(result.actorKind).toBe('agent');
		expect(result.entries.length).toBeGreaterThan(0);
		expect(result.entries.every((e) => e.actor.kind === 'agent')).toBe(true);
	});

	it('filters entries to a linked block audit context', () => {
		logAudit({
			actor: { kind: 'human', userId: 'brylie' },
			action: 'update_record',
			targetRecordId: 'block-a'
		});
		logAudit({
			actor: { kind: 'human', userId: 'brylie' },
			action: 'update_record',
			targetRecordId: 'block-b'
		});

		const result = load(urlEvent({ targetRecordId: 'block-a' })) as unknown as AuditLoadResult;

		expect(result.targetRecordId).toBe('block-a');
		expect(result.entries).toHaveLength(1);
		expect(result.entries[0]?.targetRecordId).toBe('block-a');
	});
});
