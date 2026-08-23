import { createHash, randomBytes } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '$lib/server/store.js';
import { accessTokens } from '$lib/server/db/schema.js';

export interface AccessToken {
	tokenHash: string;
	clientLabel: string;
	allowedDocumentIds: string[];
	allowedCollectionIds: string[];
	createdAt: number;
	revokedAt?: number;
}

function rowToToken(row: typeof accessTokens.$inferSelect): AccessToken {
	return {
		tokenHash: row.tokenHash,
		clientLabel: row.clientLabel,
		allowedDocumentIds: row.allowedDocumentIds,
		allowedCollectionIds: row.allowedCollectionIds,
		createdAt: row.createdAt,
		revokedAt: row.revokedAt ?? undefined
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

	getDb().insert(accessTokens).values(record).run();

	return { token, record };
}

/** Verifies a raw bearer token and returns its (non-revoked) record, or null. */
export function verifyToken(token: string): AccessToken | null {
	const row = getDb()
		.select()
		.from(accessTokens)
		.where(eq(accessTokens.tokenHash, hashToken(token)))
		.get();
	if (!row || row.revokedAt) return null;
	return rowToToken(row);
}

export function listTokens(): AccessToken[] {
	const rows = getDb().select().from(accessTokens).orderBy(desc(accessTokens.createdAt)).all();
	return rows.map(rowToToken);
}

/** A team member can revoke their own client's connection at any time — no admin action required (PRD). */
export function revokeToken(tokenHash: string): void {
	getDb()
		.update(accessTokens)
		.set({ revokedAt: Date.now() })
		.where(eq(accessTokens.tokenHash, tokenHash))
		.run();
}

/** Persists an access grant for a newly created document to SQLite so subsequent tool calls succeed. */
export function grantDocumentAccess(tokenHash: string, documentId: string): void {
	const db = getDb();
	const row = db
		.select({ allowedDocumentIds: accessTokens.allowedDocumentIds })
		.from(accessTokens)
		.where(eq(accessTokens.tokenHash, tokenHash))
		.get();
	if (!row) return;
	if (!row.allowedDocumentIds.includes(documentId)) {
		db.update(accessTokens)
			.set({ allowedDocumentIds: [...row.allowedDocumentIds, documentId] })
			.where(eq(accessTokens.tokenHash, tokenHash))
			.run();
	}
}

/** Persists an access grant for a newly created collection to SQLite so subsequent tool calls succeed. */
export function grantCollectionAccess(tokenHash: string, collectionId: string): void {
	const db = getDb();
	const row = db
		.select({ allowedCollectionIds: accessTokens.allowedCollectionIds })
		.from(accessTokens)
		.where(eq(accessTokens.tokenHash, tokenHash))
		.get();
	if (!row) return;
	if (!row.allowedCollectionIds.includes(collectionId)) {
		db.update(accessTokens)
			.set({ allowedCollectionIds: [...row.allowedCollectionIds, collectionId] })
			.where(eq(accessTokens.tokenHash, tokenHash))
			.run();
	}
}

export function tokenAllowsParent(token: AccessToken, parentId: string): boolean {
	return (
		token.allowedDocumentIds.includes(parentId) || token.allowedCollectionIds.includes(parentId)
	);
}
