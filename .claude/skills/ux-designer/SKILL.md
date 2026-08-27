---
name: ux-designer
description: Use this skill for judgment calls about interaction quality, visual consistency, and accessibility in Compendium (brylie/compendium) — reviewing a new or changed UI surface (a block type, a Collection view, a toolbar control) against docs/specifications/design-system.md's tokens and component patterns, checking whether editor behavior (Enter/Backspace/toolbar-click semantics) still matches the PRD's word-processor-parity acceptance criteria, auditing keyboard navigation/focus management/screen-reader support against the WCAG 2.1 AA baseline issue #18 sets, keeping the collaborative-state UI (hold/placeholder shimmer, live presence) consistent as new agent-facing surfaces ship, triaging real dogfooding UX friction (issue #5) into a design fix vs. an accessibility gap vs. a PRD-level issue, or catching a component that only specifies colors for one theme instead of both light and dark. Trigger this any time the user asks things like "does this match the design system", "is this accessible", "will a screen reader announce this", "does this feel right", "should this be a token", or describes UI/UX friction from actually using the app — even if they don't say "design" or "UX" explicitly. For deciding whether something belongs in the product at all, use product-owner; for tracking the resulting work as a GitHub issue, use backlog-refinement.
---

# UX & accessibility design (brylie/compendium)

[`docs/specifications/design-system.md`](../../../docs/specifications/design-system.md)
is the visual language — tokens, typography, component patterns, icon
conventions — settled through real design exploration, "ready to
implement." This skill is what keeps new UI work honest to it, and what
owns the accessibility bar the PRD and issue #18 both call out as
something to design in, not retrofit.

**Division of labor:** `product-owner` decides whether a feature belongs in
the product; `backlog-refinement` tracks the resulting work as issues; this
skill owns whether a UI surface — new or already shipped — is actually
good: on-token, behaviorally correct per the PRD's own interaction
contracts, and usable via keyboard and screen reader. When this skill's
review produces backlog work, hand off to `backlog-refinement` the same way
`product-owner` does — don't duplicate its filing/prioritizing logic here.

## Write posture

**`docs/specifications/design-system.md` follows the same rule
`product-owner` uses for `docs/prd.md` and judgment-call specs: show the
exact diff, wait for the user's go-ahead, before writing it.** This is a
living pattern/token reference, not an implementation detail — changing what
it says changes what every future component is expected to match.

**Actual UI code (Svelte components, CSS, ARIA attributes, keyboard
handlers) is different: fix it the normal engineering way** — implement,
validate (`npm run test`, `npm run lint`, `npm run check`), open a PR the
user reviews before merge. Don't invent a second confirm-before-write gate
for ordinary code changes; the PR review is that gate, same reasoning
`product-owner` uses for routine spec updates written as part of
implementing an already-scoped issue. Where this skill adds value on the
code side is _before_ writing it (§7) and _reviewing_ what's already
written (§1–§4), not gating the mechanics of writing it.

## 1. Design-system fidelity

Every color, font, and reusable pattern should trace back to
`design-system.md`'s tokens — `bg`/`surface`/`sidebar-bg`/`fg`/`muted`/
`border`/`accent`/`accent-fg`, the three-font system (Lora/Source Sans 3/
JetBrains Mono), and the documented component patterns (sidebar, held
block, callout, slash menu, checkbox). Run the bundled audit to catch drift
mechanically — path is relative to the repo root, not this skill's own
directory:

```bash
mise exec -- python3 .claude/skills/ux-designer/scripts/audit_design_tokens.py
```

This flags hardcoded hex colors, raw `oklch(...)` calls, and hardcoded
`font-family` declarations outside `src/routes/layout.css` (the one place
tokens are defined) — every other file should reference them via Tailwind
utilities (`bg-bg`, `text-accent`, …), never restate a color or font
directly. It's a mechanical proxy, not the full check: also read new
component code for whether it's actually _using_ an existing pattern
(callout styling, held-block treatment) rather than inventing a
visually-similar one from scratch.

When a real new pattern is needed, that's a design-system.md edit (§ Write
posture above) — update the "Component patterns" section so it keeps
describing reality, the same way `product-owner` keeps the PRD from going
stale.

## 2. Accessibility baseline (WCAG 2.1 AA)

Issue #18 states the bar precisely: keyboard navigation through Document
blocks and Collection views, full toolbar keyboard operability with
correct focus management, screen-reader announcements for collaborative
state (another actor's cursor/hold in a block, the agent-hold indicator),
and a baseline WCAG 2.1 AA audit of the core editing surface. Its own
premise — "design this in now, before #7 and #11 ship" — didn't hold: both
shipped first. Treat this as real retrofit debt on already-live surfaces,
not just a checklist for future work.

There's no automated accessibility check wired into this repo yet (no
axe-core or equivalent in the Playwright/Tier B suite) — until there is,
this is a manual review responsibility: tab through the surface being
reviewed, check focus order and visible focus states, verify interactive
elements have accessible names (not just a visual icon), and check that a
screen reader would announce collaborative state changes, not just render
them visually (a shimmer + avatar is silent to a screen reader unless
something also updates `aria-live` or equivalent). If reviewing this
repeatedly by hand becomes the bottleneck, that's itself worth flagging as
backlog work — adding automated accessibility testing to Tier B — rather
than continuing to do it by hand indefinitely.

## 3. Interaction-contract fidelity

The PRD's Block Editor Interaction requirement and
[`rich-text-toolbar.md`](../../../docs/specifications/rich-text-toolbar.md)
specify editor behavior at the level of individual keystrokes, not just
vibes — Enter splits at the caret, Backspace at block-start joins onto the
previous block, a toolbar control converts a text-bearing block in place
but inserts a new block after a structural one, pressing Enter twice at a
list's start exits the list instead of adding another empty item. These
are PRD `_Acceptance:_` clauses, not soft preferences. Before treating an
editor change as done, walk through the specific scenario each affected
clause describes — don't just confirm "it feels fine," confirm the
documented behavior still holds exactly.

## 4. Collaborative-state UX

The hold/placeholder pattern (shimmer bar + acting-agent avatar + label)
and live presence indicators are a deliberate design choice — the PRD
explicitly rejects a fake blinking-cursor illusion, since an agent writing
over MCP has no continuous keystroke stream to attach one to. Any new
agent-facing surface (a new block type an agent can hold, a new view an
agent can write into) should reuse this same visual language rather than
inventing its own "agent is working" treatment. If a genuinely new kind of
collaborative state doesn't fit the existing pattern, that's a
design-system.md addition (§1), not a one-off.

## 5. Dogfooding UX-friction triage

Issue #5 ("Dogfooding-driven editor UX refinement") is the standing intake
for this — track its checklist state, since an empty one means real
friction isn't being captured yet, not that there isn't any. When friction
comes up, sort it:

- **Design-system violation** — an existing pattern wasn't followed. Fix
  directly (normal engineering workflow, § Write posture).
- **Accessibility gap** — doesn't meet the §2 bar. Route through §2's
  process; file/track via `backlog-refinement` if it's more than a quick
  fix.
- **PRD-level interaction-contract issue** — the _documented_ behavior
  itself is wrong, not just its implementation. That's a `product-owner`
  question (their §1, not this skill's to decide alone).
- **Genuinely new UX idea** — doesn't violate anything documented, just
  would be better. Hand off to `backlog-refinement` to file and prioritize
  normally.

## 6. Cross-surface consistency

Table, Kanban, and Calendar
([`collection-views.md`](../../../docs/specifications/collection-views.md))
share one underlying query/projection path and should read as one product,
not three independently designed screens. When a new view or view feature
ships, check it reuses existing patterns (property-value rendering, filter/
sort controls, empty states) instead of establishing its own — the PRD's
own "Views don't own data, they query it" principle has a UX analogue:
views shouldn't each invent their own presentation language either.

## 7. New-surface design review, upstream of implementation

Before a new block type, view, or UI surface gets built, check the
proposal against `design-system.md`'s tokens/patterns and the §2
accessibility baseline — the same "catch it before it's written, not in
review" posture `product-owner`'s §9 takes for specs. A new interactive
element designed without keyboard operability in mind from the start is
far more expensive to retrofit than to design in — issue #18 itself is the
proof of that cost.

## 8. Dark/light theme parity

`design-system.md` is explicit: light and dark are "two independent,
fully-specified sets... never derive one from the other with a filter."
`scripts/audit_design_tokens.py` catches a component that hardcodes a
color outside the token system entirely; it does **not** catch a token
correctly used but only defined for one theme (a `@theme` addition without
a matching `.dark` override) — check new token additions by hand for both
blocks.

## Periodic UX/accessibility review

The "run this regularly" entry point, mirroring `backlog-refinement`'s
grooming pass and `product-owner`'s product review — when asked to review
the UI, check accessibility status, or periodically on your own:

1. Run `scripts/audit_design_tokens.py` for the mechanical drift check
   (§1).
2. Check issue #18's checklist state and spot-check one or two shipped
   surfaces against it by hand (§2) — don't assume "no new complaints"
   means accessible.
3. Check issue #5's checklist — is dogfooding friction actually being
   captured, or sitting empty by default?
4. Spot-check one or two recently-changed editor interactions against
   their PRD acceptance criteria (§3).
5. Look for a recently-added agent-facing surface that reinvented
   collaborative-state UI instead of reusing the hold/placeholder pattern
   (§4).

Summarize as a direct punch list — what's solid, what's drifted, what
needs a decision or a hand-off — the same shape the other two skills use.
Don't silently fix `design-system.md` or file issues without confirmation;
route those through the write posture and hand-off rules above.
