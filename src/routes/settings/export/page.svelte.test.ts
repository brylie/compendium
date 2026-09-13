import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import Page from './+page.svelte';

const baseData = {
	spaces: [],
	documents: [],
	collections: [],
	activeSpaceId: 'space-1'
};

describe('settings/export +page.svelte', () => {
	it('renders export settings page with disabled mirror status', () => {
		render(Page, {
			data: {
				...baseData,
				mirrorConfig: {
					enabled: false,
					outputDir: './markdown-export',
					syncIntervalMs: 3600000
				}
			},
			form: null
		});

		expect(screen.getByText('Workspace Export & Backup')).toBeInTheDocument();
		expect(screen.getByText('Enable Markdown Mirror')).toBeInTheDocument();
		expect(screen.getByText('Download Workspace ZIP')).toBeInTheDocument();
		expect(screen.queryByText('Sync Now')).not.toBeInTheDocument();
	});

	it('renders export settings page with enabled mirror status and sync button', () => {
		const mirrorConfig = {
			enabled: true,
			outputDir: '/custom/export/dir',
			syncIntervalMs: 3600000
		};
		render(Page, {
			data: {
				...baseData,
				mirrorConfig
			},
			form: { success: true, mirrorConfig }
		});

		expect(screen.getByText('Sync Now')).toBeInTheDocument();
		expect(screen.getByText('Settings updated successfully!')).toBeInTheDocument();
	});

	it('displays form error banner when present', () => {
		render(Page, {
			data: {
				...baseData,
				mirrorConfig: {
					enabled: false,
					outputDir: './markdown-export',
					syncIntervalMs: 3600000
				}
			},
			form: { error: 'Failed to update mirror configuration' }
		});

		expect(screen.getByText('Failed to update mirror configuration')).toBeInTheDocument();
	});
});
