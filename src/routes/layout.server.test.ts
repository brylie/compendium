import { describe, expect, it } from 'vitest';
import { load } from './+layout.server';
import { createCollection, createDocument } from '$lib/services';
import { CURRENT_USER } from '$lib/server/current-user';
import { resolveRequestContext } from '$lib/server/request-context';

describe('routes/+layout.server: sidebar navigation data', () => {
	it('lists documents and collections for the current user', () => {
		createDocument(CURRENT_USER, { title: 'Sidebar Doc' });
		createCollection(CURRENT_USER, { title: 'Sidebar Table' });

		const result = load({
			params: {},
			locals: { requestContext: resolveRequestContext() }
		} as unknown as Parameters<typeof load>[0]) as unknown as {
			documents: { title: string }[];
			collections: { title: string }[];
		};

		expect(result.documents.some((d) => d.title === 'Sidebar Doc')).toBe(true);
		expect(result.collections.some((c) => c.title === 'Sidebar Table')).toBe(true);
	});
});
