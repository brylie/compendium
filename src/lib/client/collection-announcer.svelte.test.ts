import { describe, expect, it, vi, afterEach } from 'vitest';
import type { WorkspaceRecord } from '$lib/data/types';
import { useRemoteUpdateAnnouncer } from './collection-announcer.svelte';

const LOCAL = { kind: 'human' as const, userId: 'local' };
const REMOTE = { kind: 'agent' as const, agentId: 'a1', name: 'Claude' };

function makeRecord(overrides: Partial<WorkspaceRecord> & { id: string }): WorkspaceRecord {
	return {
		parentId: 'col-1',
		order: 'a0',
		createdBy: LOCAL,
		createdAt: 0,
		lastEditedBy: LOCAL,
		lastEditedAt: 0,
		properties: {},
		...overrides
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe('useRemoteUpdateAnnouncer', () => {
	it('announces a remote add, but not a local one', () => {
		const announcer = useRemoteUpdateAnnouncer({ noun: 'row' });
		announcer.notify('col-1', []);
		expect(announcer.text).toBe('');

		announcer.notify('col-1', [makeRecord({ id: 'r1', createdBy: LOCAL, lastEditedBy: LOCAL })]);
		expect(announcer.text).toBe('');

		announcer.notify('col-1', [
			makeRecord({ id: 'r1', createdBy: LOCAL, lastEditedBy: LOCAL }),
			makeRecord({ id: 'r2', createdBy: REMOTE, lastEditedBy: REMOTE })
		]);
		expect(announcer.text).toContain('Claude added a row');
	});

	it('announces two consecutive remote edits that happen to share the same millisecond timestamp', () => {
		// Reproduces the reported gap: updateRecordProperties stamps
		// lastEditedAt with Date.now() at millisecond precision, so two
		// distinct remote edits landing in the same millisecond must not be
		// indistinguishable to the announcer's "did this change" check.
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		const now = Date.now();

		const announcer = useRemoteUpdateAnnouncer({ noun: 'row' });
		const original = makeRecord({
			id: 'r1',
			createdBy: REMOTE,
			lastEditedBy: REMOTE,
			lastEditedAt: now,
			properties: { name: { type: 'text', value: 'first' } }
		});
		announcer.notify('col-1', [original]);
		expect(announcer.text).toBe('');

		const firstEdit = makeRecord({
			id: 'r1',
			createdBy: REMOTE,
			lastEditedBy: REMOTE,
			lastEditedAt: now, // same millisecond as `original`
			properties: { name: { type: 'text', value: 'second' } }
		});
		announcer.notify('col-1', [firstEdit]);
		expect(announcer.text).toContain('Claude edited a row');
		const afterFirstEdit = announcer.text;

		const secondEdit = makeRecord({
			id: 'r1',
			createdBy: REMOTE,
			lastEditedBy: REMOTE,
			lastEditedAt: now, // still the same millisecond
			properties: { name: { type: 'text', value: 'third' } }
		});
		announcer.notify('col-1', [secondEdit]);
		expect(announcer.text).toContain('Claude edited a row');
		expect(announcer.text).not.toBe(afterFirstEdit);
	});

	it('does not announce a re-read that carries identical property content', () => {
		const announcer = useRemoteUpdateAnnouncer({ noun: 'row' });
		const record = makeRecord({
			id: 'r1',
			createdBy: REMOTE,
			lastEditedBy: REMOTE,
			properties: { name: { type: 'text', value: 'same' } }
		});
		announcer.notify('col-1', [record]);
		expect(announcer.text).toBe('');

		// A fresh object with identical property values — the shape every
		// observeDeep-triggered refresh() produces regardless of whether this
		// particular record actually changed.
		announcer.notify('col-1', [{ ...record }]);
		expect(announcer.text).toBe('');
	});

	it('reports a remote removal unattributed, and suppresses one flagged via noteLocalRemoval', () => {
		const announcer = useRemoteUpdateAnnouncer({ noun: 'row' });
		announcer.notify('col-1', [
			makeRecord({ id: 'local', createdBy: LOCAL }),
			makeRecord({ id: 'remote', createdBy: REMOTE })
		]);

		announcer.noteLocalRemoval('local');
		announcer.notify('col-1', [makeRecord({ id: 'remote', createdBy: REMOTE })]);
		expect(announcer.text).toBe('');

		announcer.notify('col-1', []);
		expect(announcer.text).toContain('A row was removed');
	});

	it('resets its baseline and clears stale text when notified for a different collectionId', () => {
		const announcer = useRemoteUpdateAnnouncer({ noun: 'row' });
		announcer.notify('col-1', []);
		announcer.notify('col-1', [makeRecord({ id: 'r1', createdBy: REMOTE, lastEditedBy: REMOTE })]);
		expect(announcer.text).toContain('Claude added a row');

		// col-2's pre-existing row must not replay as "just added", and the
		// stale col-1 announcement must not linger.
		announcer.notify('col-2', [makeRecord({ id: 'pre-existing', createdBy: REMOTE })]);
		expect(announcer.text).toBe('');

		announcer.notify('col-2', [
			makeRecord({ id: 'pre-existing', createdBy: REMOTE }),
			makeRecord({ id: 'new', createdBy: REMOTE, lastEditedBy: REMOTE })
		]);
		expect(announcer.text).toContain('Claude added a row');
	});

	it('uses describeEdit for a specific message, falling back to the generic wording when it returns undefined', () => {
		const announcer = useRemoteUpdateAnnouncer({
			noun: 'card',
			describeEdit: (prior, current) => {
				const priorValue = prior.properties?.status;
				const nextValue = current.properties?.status;
				if (JSON.stringify(priorValue) === JSON.stringify(nextValue)) return undefined;
				return 'moved a card to Done';
			}
		});
		const original = makeRecord({
			id: 'r1',
			createdBy: REMOTE,
			lastEditedBy: REMOTE,
			properties: { status: { type: 'select', value: 'todo' }, note: { type: 'text', value: 'a' } }
		});
		announcer.notify('col-1', [original]);

		// A property changes that describeEdit doesn't care about — falls back
		// to the generic wording.
		announcer.notify('col-1', [
			makeRecord({
				...original,
				properties: { ...original.properties, note: { type: 'text', value: 'b' } }
			})
		]);
		expect(announcer.text).toContain('Claude edited a card');

		announcer.notify('col-1', [
			makeRecord({
				...original,
				properties: { ...original.properties, status: { type: 'select', value: 'done' } }
			})
		]);
		expect(announcer.text).toContain('Claude moved a card to Done');
	});
});
