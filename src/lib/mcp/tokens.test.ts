import { describe, expect, it } from 'vitest';
import {
	createToken,
	grantCollectionAccess,
	grantDocumentAccess,
	listTokens,
	revokeToken,
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
});
