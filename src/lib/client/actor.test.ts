import { describe, expect, it } from 'vitest';
import { CURRENT_USER } from './actor';

describe('actor: local single-tenant identity', () => {
	it('is a fixed human actor named "local"', () => {
		expect(CURRENT_USER).toEqual({ kind: 'human', userId: 'local' });
	});
});
