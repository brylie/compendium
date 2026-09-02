// A small, fixed palette for Select field options (issue #94). Color is
// supplementary to an option's label — every place that renders a color
// (Board's column dot, the field editor's swatch) always renders the label
// alongside it, so the palette only needs to be reasonably distinguishable,
// not colorblind-disambiguating on its own. New options cycle through this
// list automatically so a freshly added option always has a color, not a
// gray default that reads as "uncolored."
//
// `PropertyDefinition.options[].color` stays a bare `string` (data-model.md
// §1) rather than a palette-index/token reference, so existing option colors
// written before this palette existed keep rendering as-is — the field
// editor's swatch picker just won't show one of these nine as "selected"
// for them.

export interface SelectOptionColor {
	value: string;
	label: string;
}

export const SELECT_OPTION_COLORS: SelectOptionColor[] = [
	{ value: 'oklch(60% 0.01 250)', label: 'Gray' },
	{ value: 'oklch(62% 0.18 25)', label: 'Red' },
	{ value: 'oklch(68% 0.15 55)', label: 'Orange' },
	{ value: 'oklch(80% 0.14 95)', label: 'Yellow' },
	{ value: 'oklch(65% 0.14 145)', label: 'Green' },
	{ value: 'oklch(65% 0.11 195)', label: 'Teal' },
	{ value: 'oklch(60% 0.13 250)', label: 'Blue' },
	{ value: 'oklch(60% 0.15 300)', label: 'Purple' },
	{ value: 'oklch(65% 0.15 350)', label: 'Pink' }
];

/** Picks the next palette color for a newly added Select option, cycling through SELECT_OPTION_COLORS so every new option gets a color automatically instead of defaulting to gray. */
export function nextSelectOptionColor(existingOptionCount: number): string {
	return SELECT_OPTION_COLORS[existingOptionCount % SELECT_OPTION_COLORS.length].value;
}
