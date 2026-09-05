# Design System

The visual language for Compendium, settled through a design-canvas exploration (three directions compared, one chosen and refined with a persistent sidebar and a recolor). This doc is cross-cutting — it applies to the Phase 0 UI getting its first real visual pass and to everything Phase 1 adds — not phase-specific like the plan docs.

**Status:** Settled direction, ready to implement.
**Stack:** Tailwind CSS v4 (`@tailwindcss/vite`, CSS-first config — confirmed from the actual `package.json`/`vite.config.ts`), currently just boilerplate in `src/routes/layout.css` (`@import 'tailwindcss'` plus the forms/typography plugins, no `@theme` block yet).

---

## 1. Tokens

Cool, calming palette — shifted from an earlier warm-terracotta direction after review; the typography and layout that direction established stayed, only the color family changed. All colors in oklch; light and dark are two independent, fully-specified sets (never derive one from the other with a filter).

| Token        | Light                    | Dark                   | Used for                                                        |
| ------------ | ------------------------ | ---------------------- | --------------------------------------------------------------- |
| `bg`         | `oklch(98% 0.006 235)`   | `oklch(20% 0.014 240)` | Page/canvas background                                          |
| `surface`    | `oklch(95.5% 0.008 235)` | `oklch(25% 0.016 240)` | Callout, code block, held-block shimmer background              |
| `sidebar-bg` | `oklch(95% 0.009 235)`   | `oklch(17% 0.015 240)` | Sidebar panel — always a touch deeper than `bg`, in both themes |
| `fg`         | `oklch(22% 0.012 235)`   | `oklch(93% 0.006 235)` | Primary text                                                    |
| `muted`      | `oklch(50% 0.008 235)`   | `oklch(67% 0.01 235)`  | Secondary text, icons, meta lines                               |
| `border`     | `oklch(89% 0.008 235)`   | `oklch(33% 0.016 240)` | Hairlines, input borders                                        |
| `accent`     | `oklch(58% 0.09 220)`    | `oklch(70% 0.1 215)`   | Links, active states, checked boxes, held-block avatar          |
| `accent-fg`  | `oklch(99% 0.004 235)`   | `oklch(15% 0.01 235)`  | Text/icon color on top of `accent`                              |

Deliberately low chroma throughout (0.006–0.1) — that's what makes it read as "calming" rather than just "blue." Don't increase saturation to make something stand out; use `accent` sparingly instead (per the design skill's rule: accent color is a lever, not a highlighter).

### Tailwind v4 wiring

Drop straight into `src/routes/layout.css`, after the existing `@import`/`@plugin` lines:

```css
@theme {
	--color-bg: oklch(98% 0.006 235);
	--color-surface: oklch(95.5% 0.008 235);
	--color-sidebar-bg: oklch(95% 0.009 235);
	--color-fg: oklch(22% 0.012 235);
	--color-muted: oklch(50% 0.008 235);
	--color-border: oklch(89% 0.008 235);
	--color-accent: oklch(58% 0.09 220);
	--color-accent-fg: oklch(99% 0.004 235);
}

@custom-variant dark (&:where(.dark, .dark *));

.dark {
	--color-bg: oklch(20% 0.014 240);
	--color-surface: oklch(25% 0.016 240);
	--color-sidebar-bg: oklch(17% 0.015 240);
	--color-fg: oklch(93% 0.006 235);
	--color-muted: oklch(67% 0.01 235);
	--color-border: oklch(33% 0.016 240);
	--color-accent: oklch(70% 0.1 215);
	--color-accent-fg: oklch(15% 0.01 235);
}
```

This gives every token a Tailwind utility for free (`bg-bg`, `text-fg`, `border-border`, `text-accent`, …), usable directly in Svelte markup instead of hand-written `<style>` blocks. **The `@custom-variant dark` line matters and is easy to skip**: Tailwind v4's `dark:` variant defaults to `prefers-color-scheme`, but this design has an explicit toggle button, not just OS-preference — the custom variant makes `dark:` respond to a `.dark` class on `<html>` instead. Toggle it in JS, persist the choice (`localStorage`), and set the class before first paint (a small inline script in `app.html`, or SvelteKit's own recommended pattern) to avoid a flash of the wrong theme on load.

## 2. Typography

Three Google Fonts, one per role — matches the mockup exactly, no substitutions:

- **Display/headings** — Lora (500/600 weight). Used for the document title and section headings only.
- **Body** — Source Sans 3 (400/500/600). Everything else: paragraphs, sidebar labels, UI chrome.
- **Code** — JetBrains Mono (400/500). Code blocks and inline `code` spans.

```html
<link
	rel="stylesheet"
	href="https://fonts.googleapis.com/css2?family=Lora:wght@500;600&family=Source+Sans+3:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap"
/>
```

Type scale observed in the mockup (px, not a rigid grid — keep these, don't round to a 4/8 scale): title 34/1.25, section heading 20, body 16/1.75, meta/labels 11–13, code 13.5–14.

## 3. Component patterns

These describe the _pattern_, not a copy-paste implementation — translate each into a Svelte component using the tokens above.

- **Persistent collapsible sidebar.** At desktop and tablet widths, this is a fixed 236px panel, `bg-sidebar-bg`, with a right border. Workspace name (Lora, small) + collapse button at top. Two sections — "Documents" (a tree: active item highlighted with `bg-surface` + `text-accent` + bold, children indented ~26px) and "Collections" (flat list, table icon). It collapses to a 44px icon rail (workspace mark + expand chevron), never fully hides at these widths — orientation is the whole point. At narrow/mobile widths, it becomes an off-canvas drawer, closed by default, opened from a persistent navigation control, and dismissed with its close control, Escape, or its backdrop. Opening moves focus into the drawer; closing restores focus to the trigger. The drawer must not cause horizontal page scrolling.
- **Held/placeholder block.** Already partially implemented (`src/routes/doc/[id]/+page.svelte` has `.placeholder`/`.holder-avatar`/`.shimmer` today) — this formalizes and extends it: circular avatar (`bg-accent`, initials, `text-accent-fg`) + animated shimmer bar (`surface`→`border`→`surface` gradient sweep, ~1.5s) + a small label naming the acting agent. Keep the existing shimmer animation timing; recolor to the new tokens and add the avatar+label if not already present.
- **Callout.** Subtle border (`border-border`, unstyled), rounded (10px). A callout with no style set keeps the original single appearance (`bg-surface`, icon in `accent`, default `fg` body text) — this remains the default for a fresh callout and for any pre-#42 one. A callout _with_ a chosen style (§6) instead uses a derived background and foreground pair as one coherent unit. Its icon and body text inherit the foreground color — the four presets use fixed tokens, and a custom choice uses per-record CSS custom properties.
- **Slash-command menu.** Floating panel, `bg-bg` (not `surface`, so it reads as "above" the page) with a soft shadow, icon+label rows, active/hovered row gets a `surface` background wash.
- **To-do checkbox.** Rounded-square box, `border` outline; checked state fills `accent` with a white check icon (`accent-fg`), and the label gets `muted` + strikethrough.
- **Space-grouped collapsible page-tree picker (issue #78, `/settings/tokens`'s "Allowed Documents" fieldset).** A flat, un-nested checkbox list can't tell two same-titled Documents apart, and this particular list is worse than the sidebar's own tree at it: it spans every Space in the workspace at once (the sidebar shows one Space at a time), so even two _differently_-titled Documents from different Spaces render with no indication of which Space either belongs to — a real problem here specifically because it gates which item an MCP client is actually granted access to. The fix is a real picker UI, not a synthesized disambiguating label: group by Space (a small `text-muted` uppercase heading per Space that has any Documents, `buildDocumentTree`'d independently per group so one Space's hierarchy never mixes with another's), then render each Space's Documents as the same collapsible indented tree the sidebar uses (chevron toggle, collapsed by default, `padding-left: {level * 14}px`) — the surrounding tree position is the disambiguating context, not an id or a timestamp. A `child-pages`-icon button next to any node with children ("Select this page and its sub-pages") checks that node and every one of its _currently existing_ descendants in one click, an explicit, visible convenience — it does not change what a Document grant means: the submitted `documentIds` stay the same flat, exact-id list the permission model has always used (`tokenAllowsParent` has no ancestor-walk), so a page added under that parent later isn't retroactively covered and the admin would need to reopen the picker and re-grant it. Collection titles don't need this treatment: they're enforced unique per-Space at write time instead (see `data-model.md` §2), so the "Allowed Collections" fieldset stays a plain flat list.
- **Block move handle.** A `grip` icon button in every block's gutter, `text-muted`, hidden (`opacity-0`) until the block row is hovered or the handle itself receives keyboard focus (`group-hover`/`focus-visible`), so it never competes visually with the text. Dragging it (pointer events, not native HTML5 drag-and-drop — see `src/routes/space/[spaceId]/doc/[id]/+page.svelte`) shows a thin `accent`-colored `.drop-indicator` line between the two rows the block would land between; releasing over it reorders, Escape cancels. Focused via Tab, the same handle is operable with `ArrowUp`/`ArrowDown` (swap with the previous/next sibling) and `Home`/`End` (move to the very start/end); each move re-announces the block's new 1-based position via a polite live region, and focus stays on the handle so repeated keystrokes keep working.

## 4. Icons

Inline SVG only — no emoji, no icon font. Stroke-based, `stroke="currentColor"` (so they inherit `fg`/`muted`/`accent` automatically via CSS), viewBox `0 0 20 20`, stroke-width 1.4–1.8, `stroke-linecap="round"` `stroke-linejoin="round"`. The mockup's icon set (document, chevron/tree, callout, toggle, code, divider, table, theme-toggle, checkmark, plus) is the starting vocabulary — extend it in the same style rather than mixing in a different icon set later.

## 5. Select-option palette

A Select field's options (`docs/specifications/data-model.md` §1's `PropertyDefinition.options[].color`) need a color distinct from the tokens in §1: those are UI chrome, deliberately low-chroma so nothing shouts; an option's color is categorical data — a workflow-state or tag color meant to be told apart at a glance in Board's column dot and the field editor's swatch picker — so this palette is more saturated on purpose. It's still supplementary, never the only signal: every place that renders one of these colors always renders the option's label alongside it (Board's column header, the field editor's option row), so the palette only needs to be reasonably distinguishable hue-to-hue, not colorblind-disambiguating on its own.

Nine colors, fixed and not user-extensible, defined in `src/lib/data/select-colors.ts` (`SELECT_OPTION_COLORS`):

| Name   | Value                 |
| ------ | --------------------- |
| Gray   | `oklch(60% 0.01 250)` |
| Red    | `oklch(62% 0.18 25)`  |
| Orange | `oklch(68% 0.15 55)`  |
| Yellow | `oklch(80% 0.14 95)`  |
| Green  | `oklch(65% 0.14 145)` |
| Teal   | `oklch(65% 0.11 195)` |
| Blue   | `oklch(60% 0.13 250)` |
| Purple | `oklch(60% 0.15 300)` |
| Pink   | `oklch(65% 0.15 350)` |

A newly added option (`addSelectOption` in `src/lib/data/records.ts`) auto-assigns the next color in this list, cycling by the field's current option count, so a fresh option is never left gray-by-default. `PropertyDefinition.options[].color` itself stays a bare `string` rather than a reference into this list — an option colored before this palette existed keeps rendering with its own arbitrary CSS color value; the field editor's swatch picker just won't show one of these nine as "currently selected" for it.

## 6. Callout style presets (issue #42)

A callout block's optional `calloutStyle` (`data-model.md` §1) is one of the four Starlight/Confluence-aligned presets, or a fully custom icon+color — see `collection-views.md`'s sibling pattern for `viewConfig`-shaped record fields (same "one coherent unit, chosen via its own picker" storage rationale) and `src/lib/components/CalloutBlock.svelte` for the actual picker UI.

**Presets** — four fixed background+text token pairs, `--color-callout-<preset>-{bg,fg}` in `src/routes/layout.css`, following §1's "two independent, fully-specified sets per theme" rule exactly (never derive dark from light with a filter) and getting the same free `bg-callout-<preset>-bg`/`text-callout-<preset>-fg` Tailwind utilities every other `--color-*` token does. Each preset also has its own fixed icon (`CALLOUT_PRESETS` in `src/lib/data/callout-style.ts`): note → the original info-circle `callout` icon, tip → `lightbulb`, caution → `warning` (triangle), danger → `danger` (octagon) — all added to `src/lib/components/Icon.svelte` in the same stroke-based style §4 describes. The icon itself carries no separate color token: it inherits the wrapper's `text-callout-<preset>-fg` via `currentColor`, the same way every other icon in this system already does.

| Preset  | Light bg               | Light text            | Dark bg                | Dark text              |
| ------- | ---------------------- | --------------------- | ---------------------- | ---------------------- |
| Note    | `oklch(95% 0.025 230)` | `oklch(32% 0.08 230)` | `oklch(26% 0.035 230)` | `oklch(88% 0.03 230)`  |
| Tip     | `oklch(95% 0.04 150)`  | `oklch(32% 0.09 150)` | `oklch(26% 0.045 150)` | `oklch(88% 0.035 150)` |
| Caution | `oklch(95% 0.05 85)`   | `oklch(35% 0.09 60)`  | `oklch(27% 0.05 70)`   | `oklch(88% 0.04 80)`   |
| Danger  | `oklch(95% 0.035 25)`  | `oklch(35% 0.12 25)`  | `oklch(26% 0.05 25)`   | `oklch(88% 0.04 20)`   |

**Custom** — an arbitrary icon (chosen from `CALLOUT_ICONS`, the four preset icons plus `star`; not the entire §4 roster, most of which are block-type glyphs that would look wrong here) plus one arbitrary base color the user picks via a native `<input type="color">`. Unlike the presets, there's no way to pre-define a fixed token for a color that isn't known until someone picks it — so `deriveCustomCalloutColors` (`src/lib/data/callout-style.ts`) computes a light-theme and a dark-theme background from the one base color at render time (mixed toward white/near-black respectively, not the base hue reused verbatim in both themes — same "own light/dark variants" rule as the presets, just computed instead of hand-tuned), and a WCAG-contrast-checked near-black/near-white text color against each. The result is passed to the block as CSS custom properties (`--callout-custom-bg-light` etc.) consumed by a `.callout-custom`/`.dark .callout-custom` rule pair in `layout.css`, so — like every token-driven color in this system — switching the `.dark` class repaints it through plain CSS, no JS re-render required.

## 7. Source of truth

The published design canvas is the visual reference for exact spacing/proportions — this doc is the token/pattern reference for implementation. If they ever disagree, treat that as a bug to reconcile, not a choice between them.
