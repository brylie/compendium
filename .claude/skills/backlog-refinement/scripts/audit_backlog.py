#!/usr/bin/env python3
"""Read-only backlog completeness sweep. Never writes anything.

Walks every open item on the project board and flags mechanical gaps:
missing Priority, missing Size, no "Done when:" acceptance-criteria line,
or a body too short to be a real spec. This is the *mechanical* half of a
grooming pass — it catches "field is empty" and "section is missing", not
"is this well-scoped" or "does this still fit the PRD". Read the flagged
issues yourself (or have Claude do it) for the judgment half; see SKILL.md.

Usage: mise exec -- python3 audit_backlog.py [--owner brylie] [--project-number 6]
"""
from __future__ import annotations

import argparse
import json

from _common import DEFAULT_OWNER, DEFAULT_PROJECT_NUMBER, require_complete_page, run_graphql

LIST_QUERY = """
query($owner: String!, $number: Int!, $after: String) {
  user(login: $owner) {
    projectV2(number: $number) {
      items(first: 50, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          content {
            ... on Issue { number title body state url }
          }
          fieldValues(first: 50) {
            pageInfo { hasNextPage }
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2SingleSelectField { name } }
              }
            }
          }
        }
      }
    }
  }
}
"""

MIN_BODY_LENGTH = 40


def fetch_all_items(owner: str, number: int) -> list[dict]:
    items = []
    after = None
    while True:
        data = run_graphql(LIST_QUERY, owner=owner, number=number, after=after)
        page = data["data"]["user"]["projectV2"]["items"]
        items.extend(page["nodes"])
        if not page["pageInfo"]["hasNextPage"]:
            break
        after = page["pageInfo"]["endCursor"]
    return items


def audit_item(item: dict) -> dict | None:
    content = item.get("content")
    # Draft issues have no content; PR items don't match the `... on Issue`
    # fragment, so content comes back as {} for both — either way, not
    # something this backlog-quality sweep should look at.
    if not content or content.get("state") != "OPEN":
        return None

    require_complete_page(item["fieldValues"]["pageInfo"], f"field values for issue #{content.get('number')}")
    fields = {}
    for fv in item["fieldValues"]["nodes"]:
        if fv and "field" in fv:
            fields[fv["field"]["name"]] = fv.get("name")

    body = content.get("body") or ""
    flags = []
    if not fields.get("Priority"):
        flags.append("missing Priority")
    if not fields.get("Size"):
        flags.append("missing Size")
    # Line-based, not a body-wide substring match: "the work is done when
    # approved" would otherwise count as satisfying the acceptance-criteria
    # convention without actually providing one.
    if not any(line.strip().lower().startswith("done when") for line in body.splitlines()):
        flags.append("no 'Done when:' acceptance criteria")
    if len(body.strip()) < MIN_BODY_LENGTH:
        flags.append(f"body under {MIN_BODY_LENGTH} chars — likely underspecified")

    if not flags:
        return None

    return {
        "number": content["number"],
        "title": content["title"],
        "url": content["url"],
        "status": fields.get("Status"),
        "priority": fields.get("Priority"),
        "size": fields.get("Size"),
        "flags": flags,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--owner", default=DEFAULT_OWNER)
    parser.add_argument("--project-number", type=int, default=DEFAULT_PROJECT_NUMBER)
    args = parser.parse_args()

    items = fetch_all_items(args.owner, args.project_number)
    flagged = [r for r in (audit_item(i) for i in items) if r]
    flagged.sort(key=lambda f: f["number"])

    print(json.dumps({"openIssuesFlagged": len(flagged), "issues": flagged}, indent=2))


if __name__ == "__main__":
    main()
