import { describe, expect, it } from 'vitest';
import { CURRENT_USER } from './current-user';

describe('server/current-user: default single-tenant identity', () => {
	it('is a fixed human actor named "local"', () => {
		expect(CURRENT_USER).toEqual({ kind: 'human', userId: 'local' });
	});
});
