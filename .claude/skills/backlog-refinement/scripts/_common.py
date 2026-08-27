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
    title) that could otherwise break the query's syntax.
    A variable whose value is None is omitted entirely, which GraphQL
    treats as unset/null for optional arguments (used for cursor-based
    pagination's first page).
    """
    args = ["gh", "api", "graphql", "-f", f"query={query}"]
    for key, value in variables.items():
        if value is None:
            continue
        args += ["-F", f"{key}={value}"]

    proc = subprocess.run(args, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        sys.exit(1)
    return json.loads(proc.stdout)
