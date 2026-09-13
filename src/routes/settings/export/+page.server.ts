import { fail } from '@sveltejs/kit';
import { getMirrorConfig, updateMirrorConfig, syncMarkdownMirror } from '$lib/services/export';
import { formString } from '$lib/server/form-data';
import type { Actions, PageServerLoad } from './$types';

/** Loads the current Markdown mirror configuration for the export settings UI. */
export const load: PageServerLoad = () => {
	return {
		mirrorConfig: getMirrorConfig()
	};
};

export const actions: Actions = {
	updateMirror: async ({ request, locals }) => {
		const data = await request.formData();
		const enabled = data.get('enabled') === 'on' || data.get('enabled') === 'true';
		const outputDir = formString(data.get('outputDir')).trim();

		if (!outputDir) {
			return fail(400, { error: 'Output directory path cannot be empty' });
		}

		const updated = updateMirrorConfig(locals.requestContext.caller, {
			enabled,
			outputDir
		});

		if (updated.enabled) {
			try {
				syncMarkdownMirror();
			} catch (err) {
				console.error('Failed immediate mirror sync:', err);
			}
		}

		return { success: true, mirrorConfig: updated };
	},
	syncNow: async () => {
		try {
			const result = syncMarkdownMirror();
			return { success: true, syncResult: result };
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Sync failed';
			return fail(500, { error: message });
		}
	}
};
