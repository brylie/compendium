"""Shared helpers for backlog-refinement scripts.

All scripts in this skill talk to GitHub exclusively through `gh`, so
authentication and API access reuse whatever `gh auth` is already set up —
no separate token handling here.
"""
import json
import subprocess
import sys

# This skill is tuned for one repo and one project board. Every script
# accepts overrides via flags, but the defaults mean the common case ("check
# issue #31", "run the grooming pass") needs no extra typing.
DEFAULT_OWNER = "brylie"
DEFAULT_REPO = "compendium"
DEFAULT_PROJECT_NUMBER = 6


def run_graphql(query: str, **variables) -> dict:
    """Runs a GraphQL query/mutation via `gh api graphql`.

    Variables are passed with -F (not -f) so gh sends them as a proper
    variables object instead of string-interpolating them into the query —
    this matters once a variable holds free text (a comment body, an issue
    title) that could otherwise break the query's syntax. But -F also
    type-sniffs: a str value that merely *looks* numeric (e.g. a project
    field's opaque option id like "79628723") gets silently sent as a
    GraphQL number, which fails against a String!/ID! argument. So the
    choice between -F and -f is made per variable from its Python type —
    real int/bool values (an issue number, a project number) use -F to get
    proper GraphQL Int/Boolean typing; str values always use -f, forcing
    them to stay strings regardless of what they look like.
    A variable whose value is None is omitted entirely, which GraphQL
    treats as unset/null for optional arguments (used for cursor-based
    pagination's first page).
    """
    args = ["gh", "api", "graphql", "-f", f"query={query}"]
    for key, value in variables.items():
        if value is None:
            continue
        flag = "-F" if isinstance(value, (int, bool)) else "-f"
        args += [flag, f"{key}={value}"]

    proc = subprocess.run(args, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        sys.exit(1)
    return json.loads(proc.stdout)


def require_complete_page(page_info: dict, what: str) -> None:
    """Fails loudly if a GraphQL connection had more pages than the query
    fetched, instead of letting a script silently read a truncated first
    page as if it were the whole result — which would report a field or
    project membership that exists (just past the fetch limit) as missing.
    Every connection this skill reads is small in practice (issue count,
    project field count), so a plain `first: N` with this guard is enough;
    it's not worth the extra complexity of real cursor pagination unless
    one of these connections actually grows past N.
    """
    if page_info.get("hasNextPage"):
        sys.exit(
            f"{what} has more results than this script fetched in one page — "
            "increase the query's `first:` limit rather than trust a truncated result."
        )
