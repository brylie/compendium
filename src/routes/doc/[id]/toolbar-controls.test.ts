import { describe, expect, it } from 'vitest';
import { computeVisibleInsertCount, TOOLBAR_CONTROLS } from './toolbar-controls';

describe('computeVisibleInsertCount', () => {
	it('shows everything when the container has not been measured yet (width <= 0)', () => {
		expect(computeVisibleInsertCount(18, 0)).toBe(18);
		expect(computeVisibleInsertCount(18, -1)).toBe(18);
	});

	it('shows everything when it all fits', () => {
		// 18 controls * 28px + 17 gaps * 4px = 572px
		expect(computeVisibleInsertCount(18, 572)).toBe(18);
		expect(computeVisibleInsertCount(18, 1000)).toBe(18);
	});

	it('reserves room for the overflow trigger once content does not fit', () => {
		// One px short of the full row: still must overflow at least one
		// control, even though every control individually would fit.
		expect(computeVisibleInsertCount(18, 571)).toBeLessThan(18);
	});

	it('fits as many controls as the width allows, minus the trigger', () => {
		// width 200 -> reserve 32px for trigger -> 168px usable -> (168+4)/32 = 5.375 -> 5
		expect(computeVisibleInsertCount(18, 200)).toBe(5);
	});

	it('never shows zero controls, even at an unusably narrow width', () => {
		expect(computeVisibleInsertCount(18, 1)).toBe(1);
		expect(computeVisibleInsertCount(18, 30)).toBe(1);
	});

	it('always overflows at least one control when it does not all fit, so the trigger has something to reveal', () => {
		for (const width of [50, 100, 150, 200, 300, 400, 500, 571]) {
			const visible = computeVisibleInsertCount(18, width);
			expect(visible).toBeLessThan(18);
		}
	});

	it('returns 0 for an empty control list', () => {
		expect(computeVisibleInsertCount(0, 500)).toBe(0);
	});

	it('stays in sync with the actual number of registered insert controls', () => {
		const insertCount = TOOLBAR_CONTROLS.filter((c) => c.group === 'insert').length;
		expect(computeVisibleInsertCount(insertCount, 0)).toBe(insertCount);
	});
});
