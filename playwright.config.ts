import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests/e2e',
	testMatch: /.*tier-b\.spec\.ts/,
	timeout: 30_000,
	fullyParallel: false,
	workers: 1,
	use: {
		channel: 'chrome',
		headless: true,
		viewport: { width: 1280, height: 720 },
		trace: 'on-first-retry'
	}
});
