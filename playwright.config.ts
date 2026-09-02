import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests/e2e',
	// Anchored at the end rather than a leading `.*` — an unanchored leading
	// wildcard against a non-matching string makes the engine retry from
	// every position in the input, which is quadratic, not linear, in input
	// length (confirmed: this exact prior pattern took >2s on a 20k-char
	// non-matching string). Harmless in practice against real file paths,
	// but there's no reason to keep the slower, needlessly unanchored form.
	testMatch: /tier-b\.spec\.ts$/,
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
