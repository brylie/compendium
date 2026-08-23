import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { ActorId } from '$lib/data/types';
import Page from './+page.svelte';

interface TestEntry {
	id: number;
	timestamp: number;
	actor: ActorId;
	action: string;
	targetRecordId: string | undefined;
}

function entry(overrides: Partial<TestEntry> = {}): TestEntry {
	return {
		id: 1,
		timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
		actor: { kind: 'human', userId: 'local' },
		action: 'record.create',
		targetRecordId: undefined,
		...overrides
	};
}

describe('audit +page', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('shows an empty-state row when there are no entries', () => {
		render(Page, {
			params: {},
			form: null,
			data: { documents: [], collections: [], entries: [], actorKind: '' }
		});
		expect(screen.getByText('No audit entries matching filter.')).toBeInTheDocument();
	});

	it('renders a row per audit entry with actor, action, and target', () => {
		render(Page, {
			params: {},
			form: null,
			data: {
				documents: [],
				collections: [],
				entries: [entry({ id: 1, targetRecordId: 'rec-42' })],
				actorKind: ''
			}
		});
		expect(screen.getByText('You')).toBeInTheDocument();
		expect(screen.getByText('record.create')).toBeInTheDocument();
		expect(screen.getByText('rec-42')).toBeInTheDocument();
	});

	it('shows an em dash when the entry has no target record', () => {
		render(Page, {
			params: {},
			form: null,
			data: {
				documents: [],
				collections: [],
				entries: [entry({ targetRecordId: undefined })],
				actorKind: ''
			}
		});
		expect(screen.getByText('—')).toBeInTheDocument();
	});

	it('formats agent and human-via-client actors distinctly', () => {
		render(Page, {
			params: {},
			form: null,
			data: {
				documents: [],
				collections: [],
				entries: [
					entry({ id: 1, actor: { kind: 'agent', agentId: 'a1', name: 'Claude' } }),
					entry({
						id: 2,
						actor: { kind: 'human-via-client', userId: 'brylie', client: 'Claude Desktop' }
					})
				],
				actorKind: ''
			}
		});
		expect(screen.getByText('Claude')).toBeInTheDocument();
		expect(screen.getByText('brylie · via Claude Desktop')).toBeInTheDocument();
	});

	it('preselects the actorKind filter from load data', () => {
		render(Page, {
			params: {},
			form: null,
			data: { documents: [], collections: [], entries: [], actorKind: 'agent' }
		});
		expect(screen.getByRole('combobox')).toHaveValue('agent');
	});

	it('submits the filter form when the actor filter changes', async () => {
		const submitSpy = vi.fn();
		HTMLFormElement.prototype.submit = submitSpy;
		const user = userEvent.setup();
		render(Page, {
			params: {},
			form: null,
			data: { documents: [], collections: [], entries: [], actorKind: '' }
		});

		await user.selectOptions(screen.getByRole('combobox'), 'human');

		expect(submitSpy).toHaveBeenCalledOnce();
	});
});
