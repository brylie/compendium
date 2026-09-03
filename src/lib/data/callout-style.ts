// Callout style presets, icon choices, and custom-color derivation (issue
// #42). The four presets are fixed CSS tokens (layout.css's
// --color-callout-<preset>-{bg,fg}) — this module only needs to know their
// names/icons/labels for UI listing, not their actual colors. A custom
// callout's colors are computed here instead, since there's no way to
// pre-define a CSS token for an arbitrary user-picked color.

import type { CalloutIcon, CalloutPreset } from './types';

export const CALLOUT_PRESETS: { value: CalloutPreset; label: string; icon: CalloutIcon }[] = [
	{ value: 'note', label: 'Note', icon: 'callout' },
	{ value: 'tip', label: 'Tip', icon: 'lightbulb' },
	{ value: 'caution', label: 'Caution', icon: 'warning' },
	{ value: 'danger', label: 'Danger', icon: 'danger' }
];

// Each value here must appear as a complete, literal string for Tailwind's
// build-time class scanner to pick it up — a runtime-interpolated class name
// like `bg-callout-${preset}-bg` would silently be purged from the
// production build, since Tailwind never actually evaluates the
// interpolation. This lookup is what lets CalloutBlock.svelte stay
// dynamic without breaking that.
export const CALLOUT_PRESET_CLASSES: Record<CalloutPreset, string> = {
	note: 'bg-callout-note-bg text-callout-note-fg',
	tip: 'bg-callout-tip-bg text-callout-tip-fg',
	caution: 'bg-callout-caution-bg text-callout-caution-fg',
	danger: 'bg-callout-danger-bg text-callout-danger-fg'
};

// The icon choices offered for a *custom* callout — the four preset icons
// (a custom callout can still look like a "note" icon-wise while using its
// own color) plus one neutral extra. Not the full Icon.svelte roster: most
// of its icons are block-type glyphs that would look wrong here.
export const CALLOUT_ICONS: { value: CalloutIcon; label: string }[] = [
	{ value: 'callout', label: 'Info' },
	{ value: 'lightbulb', label: 'Lightbulb' },
	{ value: 'warning', label: 'Warning' },
	{ value: 'danger', label: 'Danger' },
	{ value: 'star', label: 'Star' }
];

export const DEFAULT_CUSTOM_CALLOUT_COLOR = '#6b7280'; // a neutral gray starting point, not tied to any preset's hue

/** Whether `hex` is a well-formed 3- or 6-digit `#rgb`/`#rrggbb` color — the only shapes {@link deriveCustomCalloutColors} and the `<input type="color">` picker that feeds it ever produce. */
export function isValidHexColor(hex: string): boolean {
	return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex);
}

function hexToRgb(hex: string): [number, number, number] {
	const normalized = hex.replace('#', '');
	const full =
		normalized.length === 3
			? normalized
					.split('')
					.map((c) => c + c)
					.join('')
			: normalized;
	const value = parseInt(full, 16);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
	const clamp = (n: number) => Math.min(255, Math.max(0, Math.round(n)));
	return `#${[clamp(r), clamp(g), clamp(b)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** Linearly blends two hex colors — `ratio` 0 returns `a`, 1 returns `b`. */
function mixHex(a: string, b: string, ratio: number): string {
	const [ar, ag, ab] = hexToRgb(a);
	const [br, bg, bb] = hexToRgb(b);
	const mix = (x: number, y: number) => x + (y - x) * ratio;
	return rgbToHex(mix(ar, br), mix(ag, bg), mix(ab, bb));
}

// WCAG 2.x relative luminance (the standard sRGB -> linear-light formula) —
// used only to pick a contrast-safe text color, not for anything perceptual
// beyond that, so no need for a full color-space library.
function relativeLuminance(hex: string): number {
	const channel = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
	};
	const [r, g, b] = hexToRgb(hex);
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(hexA: string, hexB: string): number {
	const [lighter, darker] = [relativeLuminance(hexA), relativeLuminance(hexB)].sort(
		(x, y) => y - x
	);
	return (lighter + 0.05) / (darker + 0.05);
}

/** The higher-contrast of near-black/near-white against `backgroundHex` — the "computed automatically for sufficient contrast" text color issue #42 asks for, not a second manually-picked color. */
function contrastTextColor(backgroundHex: string): string {
	const NEAR_BLACK = '#1a1a1a';
	const NEAR_WHITE = '#f5f5f5';
	return contrastRatio(backgroundHex, NEAR_WHITE) >= contrastRatio(backgroundHex, NEAR_BLACK)
		? NEAR_WHITE
		: NEAR_BLACK;
}

export interface CustomCalloutColors {
	bgLight: string;
	fgLight: string;
	bgDark: string;
	fgDark: string;
}

/**
 * Derives a light-theme and a dark-theme background+text pair from one
 * user-picked base color — "own light/dark variants... a custom callout
 * shouldn't hardcode a single-theme color" (issue #42). The light variant is
 * the base color tinted mostly toward white (a pastel wash, matching the
 * preset tokens' low-chroma light backgrounds); the dark variant is tinted
 * mostly toward a near-black base instead of toward the base color's own
 * (likely too-bright-for-dark-mode) tone. Each variant's text color is
 * computed independently against *that* variant's own background, since an
 * unusual hue could in principle need different text choices per theme.
 */
export function deriveCustomCalloutColors(baseHex: string): CustomCalloutColors {
	// Malformed input shouldn't reach hexToRgb's parseInt (NaN-derived RGB,
	// invalid CSS) — records.ts's write paths already validate before
	// persisting, but this stays defensive for anything persisted before
	// that validation existed.
	const base = isValidHexColor(baseHex) ? baseHex : DEFAULT_CUSTOM_CALLOUT_COLOR;
	const bgLight = mixHex(base, '#ffffff', 0.82);
	const bgDark = mixHex(base, '#141414', 0.72);
	return {
		bgLight,
		fgLight: contrastTextColor(bgLight),
		bgDark,
		fgDark: contrastTextColor(bgDark)
	};
}
