# Design System

The visual language for AgentSpace, settled through a design-canvas exploration (three directions compared, one chosen and refined with a persistent sidebar and a recolor). This doc is cross-cutting — it applies to the Phase 0 UI getting its first real visual pass and to everything Phase 1 adds — not phase-specific like the plan docs.

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

- **Persistent collapsible sidebar.** Fixed 236px panel, `bg-sidebar-bg`, right border. Workspace name (Lora, small) + collapse button at top. Two sections — "Documents" (a tree: active item highlighted with `bg-surface` + `text-accent` + bold, children indented ~26px) and "Collections" (flat list, table icon). Collapses to a 44px icon rail (workspace mark + expand chevron), never fully hides — orientation is the whole point, per the reasoning that motivated adding it.
- **Held/placeholder block.** Already partially implemented (`src/routes/doc/[id]/+page.svelte` has `.placeholder`/`.holder-avatar`/`.shimmer` today) — this formalizes and extends it: circular avatar (`bg-accent`, initials, `text-accent-fg`) + animated shimmer bar (`surface`→`border`→`surface` gradient sweep, ~1.5s) + a small label naming the acting agent. Keep the existing shimmer animation timing; recolor to the new tokens and add the avatar+label if not already present.
- **Callout.** `bg-surface`, subtle border, rounded (10px), icon in `accent` + body text. One icon style throughout (see §4) — don't mix callout "severity" icons (info/warning/etc.) without deciding that's a real need first.
- **Slash-command menu.** Floating panel, `bg-bg` (not `surface`, so it reads as "above" the page) with a soft shadow, icon+label rows, active/hovered row gets a `surface` background wash.
- **To-do checkbox.** Rounded-square box, `border` outline; checked state fills `accent` with a white check icon (`accent-fg`), and the label gets `muted` + strikethrough.

## 4. Icons

Inline SVG only — no emoji, no icon font. Stroke-based, `stroke="currentColor"` (so they inherit `fg`/`muted`/`accent` automatically via CSS), viewBox `0 0 20 20`, stroke-width 1.4–1.8, `stroke-linecap="round"` `stroke-linejoin="round"`. The mockup's icon set (document, chevron/tree, callout, toggle, code, divider, table, theme-toggle, checkmark, plus) is the starting vocabulary — extend it in the same style rather than mixing in a different icon set later.

## 5. Source of truth

The published design canvas is the visual reference for exact spacing/proportions — this doc is the token/pattern reference for implementation. If they ever disagree, treat that as a bug to reconcile, not a choice between them.
