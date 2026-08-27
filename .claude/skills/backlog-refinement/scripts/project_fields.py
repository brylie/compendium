#!/usr/bin/env python3
"""Fetches the project board's field definitions: every field's id, and for
single-select fields (Priority, Size, Status), every option's id.

Field/option ids aren't guessed or cached anywhere in this skill — the board
schema can change (a new Priority tier, a renamed Size option), and a stale
hardcoded id would fail mutations silently or apply the wrong value. Every
script that writes to the board calls get_schema() fresh instead.

Usage: python3 project_fields.py [--owner brylie] [--project-number 6]

Assumes a *user*-owned project (`user(login: ...)`), not an organization
project — this board lives under github.com/users/brylie/projects/6. If this
skill is ever pointed at an org project, swap the query's `user(login: ...)`
for `organization(login: ...)`.
"""
from __future__ import annotations

import argparse
import json

from _common import DEFAULT_OWNER, DEFAULT_PROJECT_NUMBER, run_graphql

QUERY = """
query($owner: String!, $number: Int!) {
  user(login: $owner) {
    projectV2(number: $number) {
      id
      title
      fields(first: 30) {
        nodes {
          ... on ProjectV2FieldCommon { id name }
          ... on ProjectV2SingleSelectField { id name options { id name } }
        }
      }
    }
  }
}
"""


def get_schema(owner: str = DEFAULT_OWNER, number: int = DEFAULT_PROJECT_NUMBER) -> dict:
    data = run_graphql(QUERY, owner=owner, number=number)
    project = data["data"]["user"]["projectV2"]
    if project is None:
        raise SystemExit(f"No project #{number} found for user {owner!r}.")
    return project


def find_field(schema: dict, field_name: str) -> dict | None:
    return next((f for f in schema["fields"]["nodes"] if f.get("name") == field_name), None)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner", default=DEFAULT_OWNER)
    parser.add_argument("--project-number", type=int, default=DEFAULT_PROJECT_NUMBER)
    args = parser.parse_args()
    print(json.dumps(get_schema(args.owner, args.project_number), indent=2))
