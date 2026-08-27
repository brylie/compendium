#!/usr/bin/env python3
"""Read-only: resolves one issue's project-board item id and its current
field values (Status, Priority, Size, ...).

Usage: mise exec -- python3 get_item.py 31 [--owner brylie] [--repo compendium] [--project-number 6]

Queries the *issue's own* projectItems rather than paging through every item
on the board and filtering by number — cheaper, and correct even once the
board has more items than fit in one page.
"""
from __future__ import annotations

import argparse
import json
import sys

from _common import DEFAULT_OWNER, DEFAULT_PROJECT_NUMBER, DEFAULT_REPO, require_complete_page, run_graphql

# first: limits below are sized well above what a real issue/item hits today
# (an issue on this repo belongs to one project; that project has ~18
# fields) — require_complete_page() fails loudly rather than silently
# truncating if that ever stops being true, instead of reporting a real
# project membership or field value as missing.
QUERY = """
query($owner: String!, $repo: String!, $issue: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $issue) {
      title
      state
      url
      projectItems(first: 20) {
        pageInfo { hasNextPage }
        nodes {
          id
          project { number title }
          fieldValues(first: 50) {
            pageInfo { hasNextPage }
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2SingleSelectField { name } }
              }
              ... on ProjectV2ItemFieldTextValue {
                text
                field { ... on ProjectV2FieldCommon { name } }
              }
              ... on ProjectV2ItemFieldNumberValue {
                number
                field { ... on ProjectV2FieldCommon { name } }
              }
            }
          }
        }
      }
    }
  }
}
"""


def field_map(item: dict) -> dict:
    require_complete_page(item["fieldValues"]["pageInfo"], f"issue field values for project item {item['id']}")
    fields = {}
    for fv in item["fieldValues"]["nodes"]:
        if not fv or "field" not in fv:
            continue
        name = fv["field"]["name"]
        fields[name] = fv.get("name", fv.get("text", fv.get("number")))
    return fields


def get_item(issue: int, owner: str = DEFAULT_OWNER, repo: str = DEFAULT_REPO,
             project_number: int = DEFAULT_PROJECT_NUMBER) -> dict:
    data = run_graphql(QUERY, owner=owner, repo=repo, issue=issue)
    gh_issue = data["data"]["repository"]["issue"]
    if gh_issue is None:
        raise SystemExit(f"Issue #{issue} not found in {owner}/{repo}.")

    require_complete_page(gh_issue["projectItems"]["pageInfo"], f"project memberships for issue #{issue}")
    item = next(
        (n for n in gh_issue["projectItems"]["nodes"] if n["project"]["number"] == project_number),
        None,
    )
    result = {
        "issue": issue,
        "title": gh_issue["title"],
        "state": gh_issue["state"],
        "url": gh_issue["url"],
        "onProject": item is not None,
    }
    if item:
        result["itemId"] = item["id"]
        result["fields"] = field_map(item)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("issue", type=int)
    parser.add_argument("--owner", default=DEFAULT_OWNER)
    parser.add_argument("--repo", default=DEFAULT_REPO)
    parser.add_argument("--project-number", type=int, default=DEFAULT_PROJECT_NUMBER)
    args = parser.parse_args()

    result = get_item(args.issue, args.owner, args.repo, args.project_number)
    print(json.dumps(result, indent=2))
    if not result["onProject"]:
        sys.exit(1)
