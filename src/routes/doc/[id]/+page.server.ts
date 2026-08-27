import { resolveWorkspaceContext } from '$lib/server/workspace-store';
import { getDocument } from '$lib/data/records';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	const { doc } = resolveWorkspaceContext();
	const document = getDocument(doc, params.id);
	return { documentId: params.id, title: document?.title ?? 'Untitled' };
};
