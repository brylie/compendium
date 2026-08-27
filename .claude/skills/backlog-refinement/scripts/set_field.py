#!/usr/bin/env python3
"""Proposes, or applies, a single-select field change on one issue's project
item (Priority, Size, or Status).

DRY RUN BY DEFAULT. Without --apply this only prints the current value, the
requested new value, and confirms the option name is valid — it makes no
GitHub API write calls at all. Pass --apply once you (or the user, via you)
have actually agreed to the change.

Usage:
  mise exec -- python3 set_field.py 31 Priority P0                # dry run — prints the plan
  mise exec -- python3 set_field.py 31 Priority P0 --apply         # applies it

This only sets a single-select field's value. It does not post the
rationale comment that should accompany most priority/size changes — see
SKILL.md's "Recording a priority or size change" section for that template;
post it yourself with `gh issue comment` right after applying.
"""
from __future__ import annotations

import argparse
import json
import sys

from _common import DEFAULT_OWNER, DEFAULT_PROJECT_NUMBER, DEFAULT_REPO, run_graphql
from get_item import get_item
from project_fields import find_field, get_schema

MUTATION = """
mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $project
    itemId: $item
    fieldId: $field
    value: { singleSelectOptionId: $option }
  }) {
    projectV2Item { id }
  }
}
"""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("issue", type=int)
    parser.add_argument("field", help="Project field name, e.g. Priority, Size, Status")
    parser.add_argument("value", help="Option name, e.g. P0, M, 'In progress'")
    parser.add_argument("--owner", default=DEFAULT_OWNER)
    parser.add_argument("--repo", default=DEFAULT_REPO)
    parser.add_argument("--project-number", type=int, default=DEFAULT_PROJECT_NUMBER)
    parser.add_argument("--apply", action="store_true", help="Actually run the mutation (default: dry run)")
    args = parser.parse_args()

    schema = get_schema(args.owner, args.project_number)
    field_def = find_field(schema, args.field)
    if not field_def or "options" not in field_def:
        available = [f["name"] for f in schema["fields"]["nodes"] if "options" in f]
        sys.exit(f"{args.field!r} isn't a single-select field on project #{args.project_number}. "
                  f"Single-select fields: {available}")

    option = next((o for o in field_def["options"] if o["name"] == args.value), None)
    if not option:
        valid = [o["name"] for o in field_def["options"]]
        sys.exit(f"{args.value!r} isn't a valid option for {args.field}. Valid options: {valid}")

    item = get_item(args.issue, args.owner, args.repo, args.project_number)
    if not item["onProject"]:
        sys.exit(f"Issue #{args.issue} is not on project #{args.project_number}.")

    current = item["fields"].get(args.field)
    plan = {
        "issue": args.issue,
        "title": item["title"],
        "field": args.field,
        "from": current,
        "to": args.value,
    }

    if current == args.value:
        print(json.dumps({**plan, "applied": False, "note": "already set to this value"}, indent=2))
        return

    if not args.apply:
        print(json.dumps({**plan, "applied": False}, indent=2))
        print("\nDry run only — no changes made. Re-run with --apply to execute.", file=sys.stderr)
        return

    run_graphql(
        MUTATION,
        project=schema["id"],
        item=item["itemId"],
        field=field_def["id"],
        option=option["id"],
    )
    print(json.dumps({**plan, "applied": True}, indent=2))


if __name__ == "__main__":
    main()
