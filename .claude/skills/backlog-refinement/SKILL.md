---
name: backlog-refinement
description: Use this skill for anything touching the GitHub issue backlog or project board for brylie/compendium (project #6, "Compendium") — filing a new bug/feature/enhancement/tech-debt issue, checking whether an issue is well-scoped (title, problem statement, non-goals, "Done when:" acceptance criteria), setting or changing an issue's Priority (P0/P1/P2) or Size (XS-XL) on the board, recording that one issue blocks/is-blocked-by/duplicates/is-prerequisite-for another, splitting an oversized issue into sub-issues, checking whether a merged PR's closing keywords actually match what it implemented, cross-checking backlog items against docs/prd.md or docs/specifications/*.md, or running a periodic grooming/cleanup pass over open issues. Trigger this any time the user asks things like "is issue #N closed", "what's the priority on this", "should we split this up", "did we link the PR to the issue", "triage this", "groom the backlog", "file a bug for X", or references a specific issue number in a planning (not implementation) context — even if they don't say "backlog" or "skill" explicitly.
---

# Backlog refinement (brylie/compendium)

This skill packages how we run the GitHub issue backlog and project board for
this repo — the detailed procedure behind CLAUDE.md's "Workflow: issue
triage, prioritization, and PR-linkage" section. Read that in CLAUDE.md
first for the one-paragraph summary; this file is the how.

Everything below assumes repo `brylie/compendium` and project board `#6`
("Compendium", https://github.com/users/brylie/projects/6) unless the user
says otherwise. The bundled scripts default to these and accept `--owner` /
`--repo` / `--project-number` overrides for the rare case they don't apply.

## The one rule that overrides everything else here

**Show the user the exact planned write, and wait for their go-ahead,
before any `gh`/GraphQL command that changes GitHub state** — a field
change, a comment, a new issue, an edit, a closure, a relationship link.
"I'm confident this is right" is not the same thing as the user having
agreed to it; don't let internal confidence substitute for asking. This is
the default, not a suggestion to weigh against convenience — the one
exception is when the user (or a standing instruction like CLAUDE.md's
CodeRabbit-response workflow, or an active CI-monitor session) has already
given durable authorization for this specific class of write, the same way
the rest of this repo's write-safety model already works.

`set_field.py` enforces this mechanically for field changes: it defaults to
a dry run and prints the planned change (issue, field, old value, new
value) without making any write call, only executing once you pass
`--apply`. Comments, new issues, edits, and closures have no such wrapper —
they're plain `gh` commands, so _you_ are the confirmation gate for those:
draft the exact text, show it, wait for agreement, then run the command.

## Bundled scripts

| Script                                           | Purpose                                                         | Writes?             |
| ------------------------------------------------ | --------------------------------------------------------------- | ------------------- |
| `project_fields.py`                              | Dump the board's field/option ids (Priority, Size, Status, ...) | No                  |
| `get_item.py <issue>`                            | Resolve one issue's project item id + current field values      | No                  |
| `set_field.py <issue> <field> <value> [--apply]` | Change a single-select field (Priority/Size/Status)             | Only with `--apply` |
| `audit_backlog.py`                               | Sweep every open board item for mechanical gaps (see below)     | No                  |

All live under `.claude/skills/backlog-refinement/scripts/`. Run them with
`mise exec -- python3 .claude/skills/backlog-refinement/scripts/<name> ...`
— the **full path from the repo root**, not just `scripts/<name>`, since
that relative form only resolves correctly if your shell happens to already
be inside this skill's own directory. `mise exec` finds this repo's
`mise.toml` by walking up from the current directory and runs the command
under the pinned Python (3.14 as of writing), regardless of what plain
`python3` on `$PATH` happens to resolve to — the OS-provided one varies by
machine and can be years older. If `mise exec -- python3 --version` doesn't
print the pinned version, run `mise install` first. Plain `python3
<path>` also works whenever it happens to be new enough, but don't rely on
that — use the `mise exec --` form.

Field/option ids are never hardcoded anywhere in this skill or its scripts —
`set_field.py` and `audit_backlog.py` both fetch the live schema on every
run. The board's fields can change (a renamed Size tier, a new Priority
level), and a stale cached id would either fail loudly or, worse, silently
apply the wrong value.

## 1. Authoring a new issue

Every issue — bug, feature, enhancement, refactor, tech-debt, doc gap — gets the same shape, matching the convention already in use across issues #13/#30/#31/#72/#74:

```markdown
<Problem statement: what's wrong or missing, and why it matters. For a bug,
include repro steps. For a feature/enhancement, say what becomes possible.>

<Optional: relevant context, links to specs/PRD sections, prior discussion.>

- [ ] <checklist item, if the work has discrete sub-parts>
- [ ] <...>

Done when: <the concrete, checkable condition that means this is finished —
not "improve X" but "X does Y, verified by Z">
```

For a feature or enhancement, add an explicit non-goals line if the natural
scope is fuzzy — "not in scope: Z" prevents the exact kind of creep CLAUDE.md
already warns about during implementation.

After filing (`gh issue create`), immediately do steps 2-4 below — an issue
without a priority is invisible in planning, which is the whole reason the
`/goal` for #30 insisted every filed issue get one. Don't treat this as a
follow-up task; it's part of filing the issue.

## 2. Classification

Apply a GitHub label for the issue type (bug/enhancement/refactor/docs/tech-
debt). As of this writing `enhancement` is the only label actually in use in
this repo — if the user wants finer-grained classification, that's a
one-time `gh label create` setup, not something to invent silently per-issue.

## 3. Prioritization

This repo has **no priority labels** — priority lives only in the project
board's `Priority` field (P0/P1/P2), which is why `gh issue view --json
labels` will never show it. Set it with:

```bash
mise exec -- python3 .claude/skills/backlog-refinement/scripts/set_field.py <issue> Priority <P0|P1|P2>          # dry run
mise exec -- python3 .claude/skills/backlog-refinement/scripts/set_field.py <issue> Priority <P0|P1|P2> --apply  # applies it
```

**Any priority change — including on a brand-new issue — gets a rationale
comment**, stating the old value (or "unset"), the new value, and the
concrete reason. This is what makes a re-triage decision legible later
instead of a silent board edit no one can explain in six months. Template
(this is the actual text used for #31 today):

> Promoted P2 → P0: #13 (also P0) is explicitly sequenced after this — its
> own body says "use #31 to validate the choice." #13's shard model can't be
> picked from measurement rather than intuition until this lands, so it
> can't sit at a lower priority than the work it blocks. Marked as blocking
> #13 accordingly.

Post it with `gh issue comment <issue> --body "..."` right after applying
the field change.

## 4. Sizing

The `Size` field (XS-XL) exists on the board but is **not yet a consistently
applied convention** — as of writing, 2 of 45 open issues have it set. Don't
treat "missing Size" as an urgent gap the way "missing Priority" is; it's a
lower-priority hygiene item, and worth a direct question to the user about
whether they want it enforced going forward before mass-backfilling it. When
an issue's scope is genuinely large (multiple design decisions plus several
independent implementation phases — #13 is the reference example), that's a
signal to consider splitting it into sub-issues regardless of whether Size
is tracked.

## 5. Relationships

GitHub CLI 2.94.0+ has native, queryable "blocks" / "blocked by"
relationships, plus sub-issues for strict parent/child decomposition — but
verify before relying on this: this repo's `mise.toml` pins `gh = "latest"`,
yet the plain `gh` a shell resolves first can easily be a different,
older install (e.g. Homebrew's) that predates the feature entirely. Always
invoke `gh` through `mise exec --` for the commands below, and confirm the
resolved version actually supports them:

```bash
mise exec -- gh --version                                   # confirm 2.94.0+ before relying on the flags below
mise exec -- gh issue view <issue> --json blockedBy,blocking # what natively blocks / is blocked by this issue
```

This repo already has native links that predate this skill — issue #13 is
natively `blockedBy` #30 and `blocking` #19 and #6, none of which was
obvious from reading issue bodies alone. Don't rely on grepping issue text
for "blocked by" and assume that's the complete picture.

To record a new blocks/blocked-by relationship, use the native link (after
confirming with the user per the write-confirmation rule above):

```bash
mise exec -- gh issue edit <issue> --add-blocked-by <other-issue>
mise exec -- gh issue edit <issue> --add-blocking <other-issue>
```

For strict parent/sub-issue decomposition (splitting one oversized issue
into several trackable pieces): `mise exec -- gh issue edit <parent>
--add-sub-issue <child-number-or-url>`.

Native links are structural, not explanatory — they show _that_ two issues
are related but not _why_. Pair every native `--add-blocked-by`/
`--add-blocking` link with a rationale comment, the same shape used for
issue #13 ↔ #31 today (recorded in prose only, since it predates this
skill's use of the native fields). For relationship types GitHub has no
native field for at all — duplicate-of, prerequisite-for-in-spirit,
anything looser than a strict block — the comment remains the _only_
record, not just the explanatory half of one:

> Blocked by #31 (CRDT capacity benchmark and resource observability,
> promoted P2 → P0 to match): this issue's own body says to "use #31 to
> validate the choice" for the shard boundary... Sequencing: #30 (done,
> foundation) → #31 (P0, must land first) → #13 (P0, this issue) → #6 (P1,
> depends on #13).

Post the rationale comment on **both** sides of the relationship — a reader
landing on either issue should see it without having to already know to
check the other one. This matters even more when the relationship is
recorded natively too, since `gh issue view --json blockedBy` only tells a
reader _that_ a link exists, not why it was made.

## 6. Status hygiene

The `Status` field (Backlog/Ready/In progress/In review/Done) should track
reality. If you notice an issue stuck "In progress" with no recent commits,
PR, or comments referencing it, or an issue whose linked PR merged weeks ago
but Status never moved to "Done", flag it — don't silently correct it
without checking whether there's in-progress work elsewhere (a branch, a
draft PR) that just hasn't been linked yet.

## 7. PRD & spec alignment

Before prioritizing or implementing an issue, check it against
[`docs/prd.md`](../../../docs/prd.md) (does it fit current goals/non-goals
and phase?) and the relevant file(s) in
[`docs/specifications/`](../../../docs/specifications/) (does the target
behavior already have a spec, and does implementing this issue mean that
spec needs updating too?). This isn't scriptable — it's a read-and-judge
step. If an issue doesn't cleanly fit the PRD, that's a signal to either
scope it down or raise the mismatch in a comment, not to silently expand
product surface. If implementing an issue reveals the PRD itself needs a
correction, that edit is part of the same piece of work (see CLAUDE.md's
"Workflow: implementing a feature or fix end-to-end").

## 8. Duplicate / staleness sweep

Before filing a new issue, search first:

```bash
gh issue list --repo brylie/compendium --search "<keywords>" --state all
```

If a near-duplicate exists, don't file a second one — comment on the
existing issue with the new context, or close one as a duplicate of the
other with a comment explaining which survives and why. Also watch for
issues that were superseded by a later decision (e.g. a design issue whose
approach was replaced by a different one chosen elsewhere) — close with a
comment pointing at what superseded it rather than leaving it to rot open.

## 9. PR-linkage audit

This is the gap that prompted this skill: PR #73 implemented #30 but the
question "did we also close #13?" needed a manual check
(`gh pr view <PR> --json closingIssuesReferences`) to answer. This isn't
mechanically detectable in general — a PR's actual scope vs. its stated
`Closes #N` keywords requires reading both. When reviewing a merged PR (or
when a user asks "is issue #N done now?"):

1. `gh pr view <PR> --json title,body,closingIssuesReferences` — see what it
   actually closed.
2. Read the PR's own description/diff against the issue(s) it plausibly
   relates to — does its actual scope match, exceed, or fall short of what
   the issue asked for?
3. If a PR's scope quietly covered part of an issue without a closing
   keyword (or an issue's checklist is now partially done because of
   unrelated work), say so directly and update that issue with a comment
   recording the partial progress — don't leave it silently ambiguous.

## 10. Periodic grooming pass

This is the actual "run this regularly" entry point — the other sections
are what you do once a gap is found, this is how you find them:

```bash
mise exec -- python3 .claude/skills/backlog-refinement/scripts/audit_backlog.py
```

This flags every open board item missing Priority, missing a `Done when:`
line, or with a suspiciously short body (Size is intentionally treated as
low-signal right now — see §4). It does **not** catch bad titles, PRD
drift, missing relationships, or PR-linkage gaps — those need a read, not a
regex. For each flagged issue:

1. If it's missing Priority: read it, decide P0/P1/P2 using the existing
   backlog as a reference point, apply via `set_field.py --apply`, and
   comment the rationale (§3).
2. If it's missing a `Done when:` line or looks underspecified: read the
   issue, and either add the missing acceptance criteria yourself (if it's
   unambiguous from context) or comment asking the filer/assignee to
   clarify.
3. Spot-check a handful (not necessarily all) of the _unflagged_ issues too
   for judgment-only gaps: does the title actually describe the problem,
   does it still fit the PRD, does it duplicate something else, is it
   secretly blocked by something with no comment saying so.

Summarize what you found and fixed as a punch list, the same shape used
earlier in this session ("Is issue 13 now closed?" → direct answer with the
supporting checklist quoted). Don't silently fix everything and report
nothing, and don't just dump the raw script output — synthesize it.
