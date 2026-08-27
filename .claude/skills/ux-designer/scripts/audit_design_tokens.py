#!/usr/bin/env python3
"""Read-only: flags hardcoded colors/fonts outside the design-system's one
source of truth (src/routes/layout.css). Never writes anything.

This is a mechanical proxy for design-system.md §1's fidelity check, not
the full check — it catches "a color/font was restated instead of using a
token," not "an existing visual pattern was ignored in favor of a new one."
Read the flagged files for that judgment call; see SKILL.md §1.

Usage: mise exec -- python3 audit_design_tokens.py [--root ../../../..]
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

# The one file design-system.md names as where tokens are actually defined
# (the `@theme` / `.dark` blocks). Every other file should reference a
# token via a Tailwind utility (bg-bg, text-accent, ...), never restate a
# raw value.
TOKEN_SOURCE = "src/routes/layout.css"

SCAN_GLOBS = ["src/**/*.svelte", "src/**/*.css", "src/**/*.ts"]
EXCLUDE_SUFFIXES = (".test.ts", ".test.svelte")

HEX_COLOR_RE = re.compile(r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b")
OKLCH_RE = re.compile(r"\boklch\(")
FONT_FAMILY_RE = re.compile(r"font-family\s*:", re.IGNORECASE)


def scan_file(path: Path, root: Path) -> list[dict]:
    findings = []
    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return findings

    rel = str(path.relative_to(root))
    for lineno, line in enumerate(text.splitlines(), start=1):
        for pattern, kind in ((HEX_COLOR_RE, "hardcoded hex color"),
                               (OKLCH_RE, "raw oklch() call"),
                               (FONT_FAMILY_RE, "hardcoded font-family")):
            match = pattern.search(line)
            if match:
                findings.append({
                    "file": rel,
                    "line": lineno,
                    "kind": kind,
                    "snippet": line.strip()[:120],
                })
    return findings


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[4]),
                         help="Repo root (default: resolved from this script's location)")
    args = parser.parse_args()
    root = Path(args.root).resolve()

    all_findings = []
    for pattern in SCAN_GLOBS:
        for path in root.glob(pattern):
            rel = str(path.relative_to(root))
            if rel == TOKEN_SOURCE:
                continue
            if any(rel.endswith(suffix) for suffix in EXCLUDE_SUFFIXES):
                continue
            all_findings.extend(scan_file(path, root))

    all_findings.sort(key=lambda f: (f["file"], f["line"]))
    print(json.dumps({
        "tokenSource": TOKEN_SOURCE,
        "filesFlagged": len({f["file"] for f in all_findings}),
        "findings": all_findings,
    }, indent=2))


if __name__ == "__main__":
    main()
