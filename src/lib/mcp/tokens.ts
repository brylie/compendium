import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '$lib/server/store.js';

export interface AccessToken {
	tokenHash: string;
	clientLabel: string;
	allowedDocumentIds: string[];
	allowedCollectionIds: string[];
	createdAt: number;
	revokedAt?: number;
}

interface TokenRow {
	token_hash: string;
	client_label: string;
	allowed_document_ids: string;
	allowed_collection_ids: string;
	created_at: number;
	revoked_at: number | null;
}

function rowToToken(row: TokenRow): AccessToken {
	return {
		tokenHash: row.token_hash,
		clientLabel: row.client_label,
		allowedDocumentIds: JSON.parse(row.allowed_document_ids),
		allowedCollectionIds: JSON.parse(row.allowed_collection_ids),
		createdAt: row.created_at,
		revokedAt: row.revoked_at ?? undefined
	};
}

export function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

/** Returns the raw bearer token once — only its hash is ever stored. */
export function createToken(input: {
	clientLabel: string;
	allowedDocumentIds: string[];
	allowedCollectionIds: string[];
}): { token: string; record: AccessToken } {
	const token = `as_${randomBytes(24).toString('base64url')}`;
	const record: AccessToken = {
		tokenHash: hashToken(token),
		clientLabel: input.clientLabel,
		allowedDocumentIds: input.allowedDocumentIds,
		allowedCollectionIds: input.allowedCollectionIds,
		createdAt: Date.now()
	};

	getDb()
		.prepare(
			`INSERT INTO access_tokens (token_hash, client_label, allowed_document_ids, allowed_collection_ids, created_at)
			 VALUES (?, ?, ?, ?, ?)`
		)
		.run(
			record.tokenHash,
			record.clientLabel,
			JSON.stringify(record.allowedDocumentIds),
			JSON.stringify(record.allowedCollectionIds),
			record.createdAt
		);

	return { token, record };
}

/** Verifies a raw bearer token and returns its (non-revoked) record, or null. */
export function verifyToken(token: string): AccessToken | null {
	const row = getDb()
		.prepare('SELECT * FROM access_tokens WHERE token_hash = ?')
		.get(hashToken(token)) as TokenRow | undefined;
	if (!row || row.revoked_at) return null;
	return rowToToken(row);
}

export function listTokens(): AccessToken[] {
	const rows = getDb()
		.prepare('SELECT * FROM access_tokens ORDER BY created_at DESC')
		.all() as TokenRow[];
	return rows.map(rowToToken);
}

/** A team member can revoke their own client's connection at any time — no admin action required (PRD). */
export function revokeToken(tokenHash: string): void {
	getDb()
		.prepare('UPDATE access_tokens SET revoked_at = ? WHERE token_hash = ?')
		.run(Date.now(), tokenHash);
}

/** Persists an access grant for a newly created document to SQLite so subsequent tool calls succeed. */
export function grantDocumentAccess(tokenHash: string, documentId: string): void {
	const row = getDb()
		.prepare('SELECT allowed_document_ids FROM access_tokens WHERE token_hash = ?')
		.get(tokenHash) as { allowed_document_ids: string } | undefined;
	if (!row) return;
	const currentIds: string[] = JSON.parse(row.allowed_document_ids);
	if (!currentIds.includes(documentId)) {
		currentIds.push(documentId);
		getDb()
			.prepare('UPDATE access_tokens SET allowed_document_ids = ? WHERE token_hash = ?')
			.run(JSON.stringify(currentIds), tokenHash);
	}
}

/** Persists an access grant for a newly created collection to SQLite so subsequent tool calls succeed. */
export function grantCollectionAccess(tokenHash: string, collectionId: string): void {
	const row = getDb()
		.prepare('SELECT allowed_collection_ids FROM access_tokens WHERE token_hash = ?')
		.get(tokenHash) as { allowed_collection_ids: string } | undefined;
	if (!row) return;
	const currentIds: string[] = JSON.parse(row.allowed_collection_ids);
	if (!currentIds.includes(collectionId)) {
		currentIds.push(collectionId);
		getDb()
			.prepare('UPDATE access_tokens SET allowed_collection_ids = ? WHERE token_hash = ?')
			.run(JSON.stringify(currentIds), tokenHash);
	}
}

export function tokenAllowsParent(token: AccessToken, parentId: string): boolean {
	return (
		token.allowedDocumentIds.includes(parentId) || token.allowedCollectionIds.includes(parentId)
	);
}
