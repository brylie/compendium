import { describe, expect, it } from 'vitest';
import {
	createToken,
	grantCollectionAccess,
	grantDocumentAccess,
	listTokens,
	revokeToken,
	tokenAllowsParent,
	verifyToken
} from './tokens';

describe('tokens: lifecycle and access grants', () => {
	it('listTokens returns every issued token, newest first', () => {
		const { record: first } = createToken({
			clientLabel: 'First',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});
		const { record: second } = createToken({
			clientLabel: 'Second',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});

		const tokens = listTokens();
		expect(tokens.map((t) => t.tokenHash)).toEqual(
			expect.arrayContaining([first.tokenHash, second.tokenHash])
		);
	});

	it('revokeToken makes a token fail verification', () => {
		const { token, record } = createToken({
			clientLabel: 'Revocable',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});
		expect(verifyToken(token)).not.toBeNull();

		revokeToken(record.tokenHash);
		expect(verifyToken(token)).toBeNull();
	});

	it('verifyToken returns null for a token that was never issued', () => {
		expect(verifyToken('as_not-a-real-token')).toBeNull();
	});

	it('grantDocumentAccess is a no-op for an unknown token hash', () => {
		expect(() => grantDocumentAccess('not-a-real-hash', 'doc-1')).not.toThrow();
	});

	it('grantDocumentAccess does not duplicate an id the token already has', () => {
		const { token, record } = createToken({
			clientLabel: 'Doc Grant',
			allowedDocumentIds: ['doc-1'],
			allowedCollectionIds: []
		});
		grantDocumentAccess(record.tokenHash, 'doc-1');
		expect(verifyToken(token)?.allowedDocumentIds).toEqual(['doc-1']);
	});

	it('grantCollectionAccess is a no-op for an unknown token hash', () => {
		expect(() => grantCollectionAccess('not-a-real-hash', 'col-1')).not.toThrow();
	});

	it('grantCollectionAccess adds a new id and does not duplicate an existing one', () => {
		const { token, record } = createToken({
			clientLabel: 'Collection Grant',
			allowedDocumentIds: [],
			allowedCollectionIds: ['col-1']
		});
		grantCollectionAccess(record.tokenHash, 'col-1');
		grantCollectionAccess(record.tokenHash, 'col-2');
		expect(verifyToken(token)?.allowedCollectionIds).toEqual(['col-1', 'col-2']);
	});

	it('createToken defaults allowedSpaceIds to an empty array when omitted', () => {
		const { record } = createToken({
			clientLabel: 'No Spaces',
			allowedDocumentIds: [],
			allowedCollectionIds: []
		});
		expect(record.allowedSpaceIds).toEqual([]);
	});

	it('createToken persists an explicit allowedSpaceIds', () => {
		const { token, record } = createToken({
			clientLabel: 'Space Grant',
			allowedDocumentIds: [],
			allowedCollectionIds: [],
			allowedSpaceIds: ['space-a']
		});
		expect(record.allowedSpaceIds).toEqual(['space-a']);
		expect(verifyToken(token)?.allowedSpaceIds).toEqual(['space-a']);
	});
});

describe('tokenAllowsParent (#6): per-ID grants compose with Space-level grants', () => {
	it('allows a directly-allowlisted Document even with no Space grant', () => {
		const { record } = createToken({
			clientLabel: 'Direct',
			allowedDocumentIds: ['doc-1'],
			allowedCollectionIds: []
		});
		expect(tokenAllowsParent(record, 'doc-1')).toBe(true);
		expect(tokenAllowsParent(record, 'doc-1', 'some-other-space')).toBe(true);
	});

	it('allows any Document/Collection in a Space-granted token, even without a direct per-ID grant', () => {
		const { record } = createToken({
			clientLabel: 'Space-Scoped',
			allowedDocumentIds: [],
			allowedCollectionIds: [],
			allowedSpaceIds: ['space-a']
		});
		expect(tokenAllowsParent(record, 'doc-never-individually-granted', 'space-a')).toBe(true);
	});

	it('denies when neither the id nor its Space is granted', () => {
		const { record } = createToken({
			clientLabel: 'Scoped Elsewhere',
			allowedDocumentIds: [],
			allowedCollectionIds: [],
			allowedSpaceIds: ['space-a']
		});
		expect(tokenAllowsParent(record, 'doc-1', 'space-b')).toBe(false);
	});

	it('denies a Space grant when the caller has no spaceId to check (untracked/legacy content)', () => {
		const { record } = createToken({
			clientLabel: 'Space-Scoped',
			allowedDocumentIds: [],
			allowedCollectionIds: [],
			allowedSpaceIds: ['space-a']
		});
		expect(tokenAllowsParent(record, 'doc-1', undefined)).toBe(false);
	});
});
