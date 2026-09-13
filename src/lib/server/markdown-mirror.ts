import { syncMarkdownMirror, getMirrorConfig } from '$lib/services/export';

let mirrorTimer: NodeJS.Timeout | null = null;
let isWired = false;

/** Wires periodic Markdown mirror synchronization once at application startup. */
export function wireMarkdownMirrorOnce(): void {
	if (isWired) return;
	isWired = true;

	const scheduleNextTick = () => {
		const config = getMirrorConfig();
		const interval = config.syncIntervalMs || 60000;

		mirrorTimer = setTimeout(() => {
			try {
				if (config.enabled) {
					syncMarkdownMirror();
				}
			} catch (err) {
				console.error('Scheduled markdown mirror sync failed:', err);
			} finally {
				scheduleNextTick();
			}
		}, interval);
	};

	scheduleNextTick();
}

/** Stops the active periodic Markdown mirror synchronization timer if present. */
export function stopMarkdownMirrorSchedule(): void {
	if (mirrorTimer) {
		clearTimeout(mirrorTimer);
		mirrorTimer = null;
	}
	isWired = false;
}
