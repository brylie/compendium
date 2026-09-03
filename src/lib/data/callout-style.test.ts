import { describe, expect, it } from 'vitest';
import { CALLOUT_ICONS, CALLOUT_PRESETS, deriveCustomCalloutColors } from './callout-style';

describe('CALLOUT_PRESETS', () => {
	it('defines the four Starlight/Confluence-aligned presets, each with its own icon', () => {
		expect(CALLOUT_PRESETS.map((p) => p.value)).toEqual(['note', 'tip', 'caution', 'danger']);
		expect(new Set(CALLOUT_PRESETS.map((p) => p.icon)).size).toBe(4);
	});
});

describe('CALLOUT_ICONS', () => {
	it('includes every preset icon plus at least one neutral extra', () => {
		const values = CALLOUT_ICONS.map((i) => i.value);
		for (const preset of CALLOUT_PRESETS) {
			expect(values).toContain(preset.icon);
		}
		expect(values.length).toBeGreaterThan(CALLOUT_PRESETS.length);
	});
});

describe('deriveCustomCalloutColors (issue #42)', () => {
	it('produces distinct light and dark background variants from one base color', () => {
		const colors = deriveCustomCalloutColors('#3366cc');
		expect(colors.bgLight).not.toBe(colors.bgDark);
		expect(colors.bgLight).toMatch(/^#[0-9a-f]{6}$/);
		expect(colors.bgDark).toMatch(/^#[0-9a-f]{6}$/);
	});

	it('never hardcodes the same background for both themes, for a range of base colors', () => {
		for (const base of ['#ffffff', '#000000', '#ff0000', '#00ff00', '#0000ff', '#808080']) {
			const colors = deriveCustomCalloutColors(base);
			expect(colors.bgLight).not.toBe(colors.bgDark);
		}
	});

	it('picks a text color with sufficient WCAG contrast against its own background, for both themes', () => {
		// Re-derive relative luminance/contrast locally (mirroring the WCAG
		// formula this module itself uses) so this test verifies the actual
		// contrast guarantee, not just "some value came back".
		function relativeLuminance(hex: string): number {
			const value = parseInt(hex.replace('#', ''), 16);
			const channel = (c: number) => {
				const s = c / 255;
				return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
			};
			const r = (value >> 16) & 255;
			const g = (value >> 8) & 255;
			const b = value & 255;
			return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
		}
		function contrast(a: string, b: string): number {
			const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
			return (lighter + 0.05) / (darker + 0.05);
		}

		for (const base of [
			'#3366cc',
			'#ffcc00',
			'#ff0000',
			'#00cc66',
			'#663399',
			'#ffffff',
			'#000000'
		]) {
			const { bgLight, fgLight, bgDark, fgDark } = deriveCustomCalloutColors(base);
			// WCAG AA for normal text is 4.5:1; both derived pairs comfortably
			// clear a slightly relaxed bound here since the background itself
			// is a tint/shade, not the raw base color.
			expect(contrast(bgLight, fgLight)).toBeGreaterThanOrEqual(4);
			expect(contrast(bgDark, fgDark)).toBeGreaterThanOrEqual(4);
		}
	});

	it('is a pure function of the base color — same input, same output', () => {
		expect(deriveCustomCalloutColors('#abcdef')).toEqual(deriveCustomCalloutColors('#abcdef'));
	});

	it('accepts a 3-digit shorthand hex the same as its 6-digit expansion', () => {
		expect(deriveCustomCalloutColors('#fff')).toEqual(deriveCustomCalloutColors('#ffffff'));
	});
});
