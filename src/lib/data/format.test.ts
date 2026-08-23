import { describe, expect, it } from 'vitest';
import { formatActor, formatTimestamp } from './format';

describe('formatActor', () => {
	it('formats the local human as "You"', () => {
		expect(formatActor({ kind: 'human', userId: 'local' })).toBe('You');
	});

	it('formats a non-local human by their userId', () => {
		expect(formatActor({ kind: 'human', userId: 'brylie' })).toBe('brylie');
	});

	it('formats an agent by name', () => {
		expect(formatActor({ kind: 'agent', agentId: 'a1', name: 'Research Agent' })).toBe(
			'Research Agent'
		);
	});

	it('formats a human-via-client actor with the client label', () => {
		expect(
			formatActor({ kind: 'human-via-client', userId: 'local', client: 'Claude Desktop' })
		).toBe('local · via Claude Desktop');
	});
});

describe('formatTimestamp', () => {
	it('renders a millisecond timestamp as a locale date/time string', () => {
		const ms = Date.UTC(2024, 0, 1, 12, 0, 0);
		expect(formatTimestamp(ms)).toBe(new Date(ms).toLocaleString());
	});
});
