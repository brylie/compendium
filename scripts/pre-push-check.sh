#!/bin/sh
set -eu

# Keep the local push gate aligned with CI so routine failures are fixed
# before consuming a remote run. The staged-file pre-commit hooks provide
# quick feedback while editing; this is the complete repository check.
npm run lint
npm run check
npm run test:coverage
npm run build
npm run test:e2e
