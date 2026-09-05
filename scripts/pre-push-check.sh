#!/bin/sh
set -eu

npm run build
npm run test:e2e
