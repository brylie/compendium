---
name: pr-backlog-reflection
description: Identify concrete, out-of-scope follow-up work noticed while implementing or reviewing a Compendium pull request. Use to turn architectural debt, defects, duplication, missing coverage, or polish gaps into deduplicated GitHub-backlog candidates; do not use for merge-readiness review findings.
---

# PR backlog reflection (brylie/compendium)

Turn useful observations from a pull request into a small, actionable backlog
set. The goal is to preserve improvements that are real but not required to
complete the current PR, without manufacturing work or expanding the PR.

This is a follow-up-discovery workflow, not a substitute for pull-request
review. A problem that makes the current PR incorrect, unsafe, or incomplete
belongs in the review or implementation work first. Do not edit code, create
GitHub issues, change project-board fields, or post comments unless the user
explicitly authorizes that mutation.

## Establish the change and its intended boundary

- Read the PR/issue description, current diff against its merge base, relevant
  tests, and the canonical specifications for touched subsystems.
- Build on observations made during implementation or review; inspect nearby
  callers, parallel adapters, and consumers only far enough to establish a
  concrete improvement opportunity.
- Use the relevant lenses from
  [the pull-request review skill](../pull-request-review/references/compendium-review-lenses.md),
  especially shared state authority, service ownership, cross-surface parity,
  persistence, trust boundaries, and test layers.

## Decide whether an observation belongs in the backlog

Keep a candidate only when it has a specific trigger or maintenance cost and a
bounded, independently valuable outcome. Good candidates commonly include:

- repeated business logic or manually synchronized schemas across adapters;
- an architectural seam, migration, lifecycle, or error path that was exposed
  by the PR but is not needed for the PR's acceptance criteria;
- missing regression, boundary, accessibility, observability, or capacity
  coverage with a clear failure mode;
- a reproducible defect outside the PR's scope; or
- a small feature or usability gap that materially improves an existing flow.

Discard preference-only nits, vague future-proofing, and speculative risks.
Do not split one root cause into several issues merely because it has several
call sites. Do not refile debt that is unrelated to the changed area unless
the work directly revealed a new, evidenced consequence.

Classify each valid observation before presenting it:

| Classification     | Use when                                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Current-PR finding | It violates the intended contract, creates a credible regression, or is necessary for a supported surface. Keep it out of the backlog list and raise it in the active review/work. |
| Backlog candidate  | It is valuable, concrete, and can be delivered independently after this PR.                                                                                                        |
| Note only          | It lacks enough evidence, duplicates existing work, or has no meaningful outcome.                                                                                                  |

## Check that the work is not already tracked

Search open and recently closed issues, related PRs, and relevant specifications
using the domain terms, affected subsystem, and likely user outcome. Merge a
candidate into existing work when the root cause and outcome overlap; mention
the existing issue rather than proposing a duplicate. If the existing issue is
only adjacent, explain the distinction.

Use the repository's backlog-refinement procedure when it is available for
priority, relationship, sizing, and GitHub issue conventions. Do not invent a
priority, owner, milestone, or product commitment when the repository contract
does not supply one.

## Report actionable candidates

Lead with `No backlog candidates identified` when none meet the bar. Otherwise,
for each candidate provide:

- **Title:** an outcome-oriented issue title.
- **Why now:** the exact observation in this PR and why it is intentionally
  outside the current scope.
- **Problem and impact:** the triggering condition and concrete cost or risk.
- **Proposed outcome:** behavior, refactoring boundary, or coverage that would
  make the work complete; include concise acceptance criteria when clear.
- **Affected area:** modules/surfaces and any important dependency or
  relationship to the current PR.
- **Evidence:** relevant file paths, tests, specifications, or a reproduction.
- **Duplicate check:** linked related issue/PR, or `none found` with the search
  terms used.

Separate ready-to-file candidates from observations that need validation. Keep
the list small and rank only when the repository's established priority rules
provide a basis. If asked to file approved candidates, create one issue per
distinct root cause and preserve the evidence and relationships in the issue
body.
