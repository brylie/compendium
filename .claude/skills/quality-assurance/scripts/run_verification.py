#!/usr/bin/env python3
"""Runs the same verification steps CI runs, in the same order, and reports
pass/fail per step. Read-only with respect to source files (it only invokes
existing npm scripts) — the point is surfacing a CI-shaped failure locally
and earlier, not replacing CI.

Default (fast) subset: lint, check, test:coverage.
--e2e adds: build, test:e2e:tier-a, test:e2e:tier-b (slower; tier-b needs
Playwright's Chrome — run `npx playwright install --with-deps chrome` once
if it's never been installed on this machine).

Usage:
    mise exec -- python3 run_verification.py
    mise exec -- python3 run_verification.py --e2e
    mise exec -- python3 run_verification.py --e2e --skip-tier-b
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

FAST_STEPS = [
    ("lint", ["npm", "run", "lint"]),
    ("check", ["npm", "run", "check"]),
    ("test:coverage", ["npm", "run", "test:coverage"]),
]

E2E_STEPS = [
    ("build", ["npm", "run", "build"]),
    ("test:e2e:tier-a", ["npm", "run", "test:e2e:tier-a"]),
    ("test:e2e:tier-b", ["npm", "run", "test:e2e:tier-b"]),
]


def run_step(name: str, cmd: list[str], cwd: Path) -> dict:
    start = time.monotonic()
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    elapsed = time.monotonic() - start
    ok = result.returncode == 0
    tail = "\n".join((result.stdout + result.stderr).splitlines()[-25:])
    return {
        "step": name,
        "ok": ok,
        "seconds": round(elapsed, 1),
        "tail": None if ok else tail,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[4]),
                         help="Repo root (default: resolved from this script's location)")
    parser.add_argument("--e2e", action="store_true", help="Also run build + both E2E tiers")
    parser.add_argument("--skip-tier-b", action="store_true", help="With --e2e, skip Playwright (tier-b) specifically")
    args = parser.parse_args()
    root = Path(args.root).resolve()

    steps = list(FAST_STEPS)
    if args.e2e:
        steps += [s for s in E2E_STEPS if not (args.skip_tier_b and s[0] == "test:e2e:tier-b")]

    results = []
    for name, cmd in steps:
        print(f"-> {name} ...", file=sys.stderr, flush=True)
        outcome = run_step(name, cmd, root)
        results.append(outcome)
        status = "PASS" if outcome["ok"] else "FAIL"
        print(f"   {status} ({outcome['seconds']}s)", file=sys.stderr, flush=True)
        if not outcome["ok"]:
            print(outcome["tail"], file=sys.stderr, flush=True)

    all_ok = all(r["ok"] for r in results)
    print()
    print(f"{'PASS' if all_ok else 'FAIL'}: {sum(r['ok'] for r in results)}/{len(results)} steps passed")
    for r in results:
        print(f"  [{'x' if r['ok'] else ' '}] {r['step']} ({r['seconds']}s)")

    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    main()
