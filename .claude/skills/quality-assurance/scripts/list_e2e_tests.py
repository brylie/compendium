#!/usr/bin/env python3
"""Read-only: lists docs/specifications/e2e-testing.md's required Tier A
test-list table side by side with the actual test titles in
tests/e2e/tier-a.test.ts and tests/e2e/tier-b.spec.ts.

This is a mechanical proxy, not an automated match — matching a prose table
row to a test title by string similarity is too fragile to trust blindly
(and the spec's own prose can go stale relative to the tests, which is
exactly the kind of drift this is meant to surface — see SKILL.md §7).
Read both lists and judge for yourself which required rows still lack an
obvious corresponding test.

Usage: mise exec -- python3 list_e2e_tests.py [--root ../../../..]
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

SPEC_PATH = "docs/specifications/e2e-testing.md"
TIER_A_PATH = "tests/e2e/tier-a.test.ts"
TIER_B_PATH = "tests/e2e/tier-b.spec.ts"

TEST_TITLE_RE = re.compile(r"""^\s*(?:it|test)\(\s*(['"`])(.*?)\1""")


def extract_required_test_rows(spec_text: str) -> list[str]:
    lines = spec_text.splitlines()
    blocks: list[list[str]] = []
    current: list[str] = []
    for line in lines:
        if line.strip().startswith("|"):
            current.append(line)
        elif current:
            blocks.append(current)
            current = []
    if current:
        blocks.append(current)

    for block in blocks:
        if len(block) < 3:
            continue
        header_cells = [c.strip().lower() for c in block[0].strip("|").split("|")]
        if not any("test" == c or c.startswith("test") for c in header_cells):
            continue
        rows = []
        for row_line in block[2:]:
            cells = [c.strip() for c in row_line.strip("|").split("|")]
            if not cells or not cells[0]:
                continue
            rows.append(cells[0])
        if rows:
            return rows
    return []


def extract_test_titles(path: Path) -> list[str]:
    if not path.exists():
        return []
    titles = []
    for line in path.read_text(encoding="utf-8").splitlines():
        match = TEST_TITLE_RE.match(line)
        if match:
            titles.append(match.group(2))
    return titles


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[4]),
                         help="Repo root (default: resolved from this script's location)")
    args = parser.parse_args()
    root = Path(args.root).resolve()

    spec_file = root / SPEC_PATH
    required_rows = extract_required_test_rows(spec_file.read_text(encoding="utf-8")) if spec_file.exists() else []
    tier_a_titles = extract_test_titles(root / TIER_A_PATH)
    tier_b_titles = extract_test_titles(root / TIER_B_PATH)

    print(json.dumps({
        "spec": SPEC_PATH,
        "requiredTierATestRows": required_rows,
        "requiredTierATestRowCount": len(required_rows),
        "actualTierATestTitles": tier_a_titles,
        "actualTierATestCount": len(tier_a_titles),
        "actualTierBTestTitles": tier_b_titles,
        "actualTierBTestCount": len(tier_b_titles),
    }, indent=2))


if __name__ == "__main__":
    main()
