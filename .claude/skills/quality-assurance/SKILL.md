---
name: quality-assurance
description: Use this skill for verifying that Compendium (brylie/compendium) actually works — functional correctness, edge-case and regression testing, and keeping the test suite (the server/client/component Vitest projects, plus Tier A protocol-level MCP/Yjs parity tests and Tier B Playwright DOM tests) comprehensive and honest. Covers: deciding which test tier a new or changed behavior needs (a service-layer unit test vs. a Tier A parity test vs. a Tier B DOM test), systematically probing edge cases (empty/duplicate/malformed input, concurrent-actor conflicts, permission-denial paths, hold-TTL expiry, transport-boundary bugs) before calling something done, writing a regression test that reproduces a reported bug before fixing it, checking whether the 80% coverage thresholds in vite.config.ts reflect real coverage or are gamed by shallow happy-path tests, cross-checking docs/specifications/e2e-testing.md's required Tier A test list against what's actually implemented, and running the same lint/check/test/build/e2e sequence CI runs before treating a change as ready for review. Trigger this any time the user asks things like "does this actually work", "what edge cases are we missing", "write a test for this", "is this covered", "will this regress", "run the tests", "find bugs in X", or hands off a bug/regression for verification — even if they don't say "QA" or "testing" explicitly. For interaction/visual/accessibility quality use ux-designer; for whether something belongs in the product use product-owner; for tracking a found bug as a GitHub issue use backlog-refinement.
---

# Quality assurance (brylie/compendium)

The reason this repo has a two-tier E2E suite at all is a real incident:
`create_document` granted itself access to the document it just created, but
that grant mutated a discarded per-request object and never reached SQLite —
invisible to the unit test suite (never crosses the MCP transport) and to
manual UI testing (never issues an MCP call at all). See
[`service-layer.md`](../../../docs/specifications/service-layer.md) §1 and
[`e2e-testing.md`](../../../docs/specifications/e2e-testing.md) §1 for the
full story. This skill exists to keep finding — and stop reintroducing —
that class of bug: the ones that pass every test you already thought to
write.

**Division of labor:** `ux-designer` owns whether a surface is _good_
(on-token, accessible, matches the PRD's interaction contracts); this skill
owns whether it _works_ — correctness under real and adversarial conditions,
and whether the test suite would actually catch it if it broke. `product-owner`
decides what belongs in the product; `backlog-refinement` tracks the
resulting work as issues. When this skill finds a bug or a coverage gap that
isn't a quick, scoped fix, hand off to `backlog-refinement` to file it (§8)
rather than duplicating that skill's triage logic here.

## Write posture

**Actual test code is normal engineering** — write it, run it, open a PR the
user reviews before merge, same as `ux-designer`'s posture for UI code. No
extra confirm-before-write gate on top of that review.

**`docs/specifications/e2e-testing.md` follows the general CLAUDE.md spec
rule**: a routine update written as part of implementing an already-scoped
issue (e.g. adding a new row to the required-test-list table for a feature
you're already building) just happens as part of that change — the PR is the
gate. A standalone judgment call about the spec itself (moving a test out of
Tier B because it turns out not to need a DOM, deciding a whole new category
of behavior needs its own tier) is a bigger edit: show the user the diff and
wait for their go-ahead first, the same way `product-owner` treats a
standalone `docs/prd.md` correction.

## 1. The test model

Four places a test can live, from `vite.config.ts`'s three Vitest projects
plus the two E2E tiers in `e2e-testing.md`:

| Layer                                   | Runner                | What it's for                                                                                                                                   |
| --------------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **`server` project**                    | Vitest, node env      | `src/**` + `tests/**` business logic — CRDT primitives (`records.ts`), service-layer functions, MCP tool logic, persistence.                    |
| **`client` project**                    | Vitest, jsdom         | `src/lib/client/**` — the y-websocket wrapper UI and MCP code share (`yjs-client.ts`).                                                          |
| **`component` project**                 | Vitest, jsdom+browser | `src/**/*.svelte.test.ts` — Svelte component behavior via `mount()` (needs the `browser` resolve condition; see the config comment for why).    |
| **Tier A** (`tests/e2e/tier-a.test.ts`) | Vitest, real server   | Protocol-boundary correctness: two independent real clients (an MCP SDK `Client`, a real `y-websocket` client) against one real running server. |
| **Tier B** (`tests/e2e/tier-b.spec.ts`) | Playwright            | Genuinely DOM-only behavior a Tier A test structurally cannot see (rendered pixels, live DOM updates) — kept deliberately small.                |

The four Vitest projects catch business-rule and CRDT bugs fast, in-process.
They **cannot** catch a bug where state is dropped exactly at the transport
boundary — a permission grant correct in memory for one call, gone on the
next — because nothing in that layer ever opens a second, independent
connection the way two real clients would. That's what Tier A is for, and
it's not optional coverage: `e2e-testing.md` §5 states the rule directly —
**write a Tier A test whenever a change touches anything permission-, grant-,
hold-, or attribution-related.**

## 2. Deciding which tier a change needs

Walk this in order for any new or changed behavior:

1. **Is it CRDT mechanics or a business rule in isolation** (a service
   function's permission check, a markdown-transcoding edge case, an
   audit-observer debounce)? → unit test in the `server`/`client`/`component`
   project, against the function directly. Per
   [`service-layer.md`](../../../docs/specifications/service-layer.md) §6,
   service functions are the natural seam: one test can assert all of a use
   case's required side effects (mutation + audit entry + any grant) in one
   place, in-process.
2. **Does it touch permission, grant, hold, or attribution** — anything
   where "worked for the first call, broke on an independent second one"
   is the failure shape? → **Tier A, always**, even if it also has unit
   coverage. Unit coverage proves the logic is right; Tier A proves the
   transport boundary doesn't drop it. These are not substitutes for each
   other.
3. **Is the only thing to verify something rendered or DOM-visible** — a
   shimmer bar appearing, a sidebar node appearing without a manual refresh,
   a visual distinction between two indicator states? → Tier B, and only if
   Tier A genuinely can't see it (Tier A never opens a DOM at all). Keep
   this tier small on purpose (`e2e-testing.md` §2) — if a Tier B test's
   actual assertion doesn't require pixels, it belongs in Tier A instead.
4. **Everything else** (a pure function, a derived value, a component's
   internal state) → whichever Vitest project already covers that file.

A single change often needs more than one of these — e.g. a new hold
behavior needs both a `holds.ts` unit test for the business rule _and_ a
Tier A test proving a second independent MCP call sees the released/granted
state correctly.

## 3. Edge-case and regression probe matrix

Before treating a feature or fix as done, walk it against these dimensions —
this is the systematic version of "what happens when," not a vibes check.
Not every dimension applies to every change; the point is to have
deliberately ruled each one out, not to have never thought about it.

- **Empty / zero state** — no rows, no blocks, no results. Does the UI (and
  any MCP read) degrade cleanly, or does something assume at-least-one?
- **Duplicate or colliding data** — two records with the same title, the
  same property value, the same slash-command match. (Issues #49 and #78 in
  this repo's own backlog are a live example of this exact class slipping
  through — a `[[wiki-link]]` resolving ambiguously, and duplicate titles
  being indistinguishable in list UIs.)
- **Concurrent-actor conflict** — two edits to the same paragraph within the
  PRD's 500ms window; a human's implicit cursor-hold racing an agent's
  explicit hold request on the same block; two agents holding overlapping
  cross-document sets.
- **Permission boundary** — a token scoped to one document/collection
  touching a different one; a denied attempt actually producing an
  `<action>_denied` audit entry per
  [`audit-coverage.md`](../../../docs/specifications/audit-coverage.md) §3,
  not just a rejected response.
- **Timing and expiry** — a hold's 90–120s TTL actually elapsing and
  reverting content; the distinct 30s Awareness `outdatedTimeout` vs. the
  separate 100s `AGENT_HOLD_TTL_MS` in `holds.ts`
  ([`collaboration.md`](../../../docs/specifications/collaboration.md)) —
  two independent timers is exactly the kind of place an off-by-one or a
  wrong-timer bug hides.
- **Malformed or unexpected input** — markdown that doesn't round-trip
  cleanly through the `Y.Text` ⇄ Markdown boundary
  ([`markdown-transcoding.md`](../../../docs/specifications/markdown-transcoding.md)),
  a `[[wiki-link]]` with no matching title, an `@mention` of a nonexistent
  actor.
- **Cross-document / cross-modality batches** — a single hold spanning a
  Document block and a Collection row; does every acceptance criterion that
  says "the agent does not need modality-specific logic" actually hold?
- **Transport-boundary independence** — per `e2e-testing.md` §2 step 7,
  after any permission- or grant-related write, make a **second, genuinely
  independent** client call (fresh object, same token) and assert _it_ sees
  the correct state — never just trust the return value of the call that
  made the change. This is the single check that would have caught the
  incident this skill exists because of.
- **Reconnect / crash / partial failure** — an agent disconnecting mid-hold;
  the non-atomic gap `service-layer.md` §2 documents by design (a Y.Doc
  mutation succeeding while the following SQLite write throws) — does that
  leave a silently inaccessible orphan, or is it handled?

## 4. Regression-first bug fixing

When a bug is reported (by the user, by CodeRabbit, by dogfooding, or found
during this skill's own review):

1. **Write a failing test that reproduces it first**, at whichever tier
   would actually have caught it — usually Tier A if it's a transport,
   permission, hold, or attribution bug, per §2. Confirm it fails for the
   right reason before touching the fix.
2. Fix the bug.
3. Confirm the new test passes and the rest of the suite still does
   (`npm run test`, plus the relevant E2E tier).
4. Keep the regression test in the same PR as the fix — don't fix now and
   promise a test later; the test is what makes it a regression fix instead
   of a patch that might silently regress again next time.

## 5. Coverage stewardship

`vite.config.ts` enforces 80% statements/branches/functions/lines via the
`v8` provider, aggregated across everything `src/**/*.{js,ts,svelte}` minus
test files. Two things this number does **not** tell you:

- **It's aggregate, not per-file.** A module sitting near 0% can hide behind
  well-covered neighbors and still leave the aggregate above 80%. Check
  `coverage/index.html` (produced by `npm run test:coverage`, uploaded as a
  CI artifact on every run) directly rather than trusting the one summary
  percentage.
- **Coverage percentage isn't edge-case coverage.** A line executed once by
  a happy-path test is "covered" by this metric even if every dimension in
  §3 above is untested for it. Treat a coverage-threshold pass as a floor,
  not as evidence of thoroughness.

## 6. Mirroring CI locally

`.github/workflows/ci.yml` runs, in order: `npm run lint` →
`npm run check` → `npm run test:coverage` → `npm run build` →
`npm run test:e2e` (Tier A then Tier B). Before treating a change as ready
for review, run at least the fast subset yourself rather than finding out
from CI:

```bash
mise exec -- python3 .claude/skills/quality-assurance/scripts/run_verification.py          # lint, check, test:coverage
mise exec -- python3 .claude/skills/quality-assurance/scripts/run_verification.py --e2e    # + build, tier-a, tier-b (slower; needs Playwright's Chrome)
```

This only runs existing commands in CI's own order and reports pass/fail
per step — it doesn't replace CI, it just surfaces the same failure earlier
and locally.

## 7. Cross-checking the Tier A required-test list

`e2e-testing.md` §2 names a specific table of required Tier A tests, each
mapped to a PRD acceptance criterion. Specs drift the same way any other
doc does — e.g. that table currently marks the UI-originated audit-log test
as "expected to fail until that gap is closed," but `tests/e2e/tier-a.test.ts`
test #11 ("A real Yjs websocket client editing directly... is still audited
exactly once per action (issue #34)") shows that gap was in fact closed —
the spec's own note is stale. Periodically:

```bash
mise exec -- python3 .claude/skills/quality-assurance/scripts/list_e2e_tests.py
```

This lists every Tier A and Tier B test title mechanically, side by side
with `e2e-testing.md`'s required-test-list rows — a mechanical proxy, not an
automated match (matching prose table rows to test titles by string
similarity is too fragile to trust blindly). Read both lists and judge which
required rows still lack an obvious corresponding test, and whether the
spec's own prose (like the "currently unmet" note above) still matches
reality.

## 8. Triage and hand-off

- **A bug with a clear, scoped fix** → fix it directly, regression-test
  first (§4), verify (§6), normal PR.
- **A bug that's actually a bigger architectural gap** — violates
  `service-layer.md`'s single-owner-per-use-case contract, or reveals a new
  instance of the audit-coverage.md's UI-mutation gap — flag it plainly
  rather than patching around it. This may need a spec update or a
  `product-owner` scope check, not just a code fix.
- **A coverage or process gap** (a whole category of behavior with no tier
  ever assigned to it, a required Tier A row from §7 still missing its
  test) → hand off to `backlog-refinement` to file and prioritize. Don't
  silently leave it as a mental note.

## Periodic QA review

The "run this regularly" entry point, mirroring the other three skills'
grooming cadence:

1. Run `run_verification.py` (§6) — does lint/check/coverage/build/e2e all
   still pass clean, or has something been quietly broken/skipped?
2. Run `list_e2e_tests.py` and diff against `e2e-testing.md`'s required-test
   table (§7) — any row still without a test? Any stale spec prose like the
   "currently unmet" example above?
3. Open `coverage/index.html` and look for any near-0% file the aggregate
   number is hiding (§5).
4. Re-read each Tier B test's own rationale against `e2e-testing.md` §2's
   "genuinely needs a rendered DOM" bar — has it grown scope creep toward
   things Tier A could cover instead?
5. Pick two or three recently merged PRs touching permission/grant/hold/
   attribution code (`git log --oneline -- src/lib/services src/lib/mcp
src/lib/server/holds.ts`) and confirm each landed with a Tier A test, per
   the standing rule in §1 — not just a unit test.
6. Walk the §3 probe matrix against one _already-shipped_ feature, not just
   new work — regressions hide in old code nobody's revisited since it
   shipped.

Summarize as a direct punch list — what's solid, what's undertested, what
needs a decision or a hand-off — the same shape the other three skills use.
Don't silently fix everything found; a bug that's more than a quick, scoped
fix goes through §8's hand-off instead of being patched in place.
