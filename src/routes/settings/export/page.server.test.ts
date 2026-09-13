import { describe, expect, it } from 'vitest';
import { load, actions } from './+page.server';
import { resolveRequestContext } from '$lib/server/request-context';

function loadEvent(): Parameters<typeof load>[0] {
	return { locals: { requestContext: resolveRequestContext() } } as unknown as Parameters<
		typeof load
	>[0];
}

function formEvent(fields: Record<string, string>): Parameters<typeof actions.updateMirror>[0] {
	const formData = new FormData();
	for (const [key, value] of Object.entries(fields)) {
		formData.set(key, value);
	}
	return {
		request: { formData: async () => formData },
		locals: { requestContext: resolveRequestContext() }
	} as unknown as Parameters<typeof actions.updateMirror>[0];
}

describe('routes/settings/export/+page.server', () => {
	it('load() returns current mirror configuration', () => {
		const result = load(loadEvent()) as unknown as { mirrorConfig: { enabled: boolean } };
		expect(result).toHaveProperty('mirrorConfig');
		expect(result.mirrorConfig).toHaveProperty('enabled');
	});

	it('updateMirror fails on empty outputDir', async () => {
		const result = await actions.updateMirror(formEvent({ outputDir: '  ' }));
		expect(result).toEqual({
			status: 400,
			data: { error: 'Output directory path cannot be empty' }
		});
	});

	it('updateMirror updates configuration and returns success', async () => {
		const result = (await actions.updateMirror(
			formEvent({ enabled: 'on', outputDir: './.data/test-export-mirror' })
		)) as unknown as { success: boolean; mirrorConfig: { enabled: boolean; outputDir: string } };

		expect(result.success).toBe(true);
		expect(result.mirrorConfig.enabled).toBe(true);
		expect(result.mirrorConfig.outputDir).toBe('./.data/test-export-mirror');
	});

	it('syncNow triggers mirror sync and returns success', async () => {
		const result = (await actions.syncNow(
			formEvent({}) as unknown as Parameters<typeof actions.syncNow>[0]
		)) as unknown as { success: boolean };

		expect(result.success).toBe(true);
	});
});
