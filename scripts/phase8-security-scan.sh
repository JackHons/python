#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

node --experimental-strip-types --test \
  tests/backend.contract.test.mjs tests/backend.e2e.test.mjs \
  tests/hidden-tests.security.test.mjs tests/ai-privacy.security.test.mjs \
  tests/backup.restore.test.mjs

echo "--- server-only token name scan (names are expected in server code; values must not be present) ---"
rg -n 'BACKEND_INTERNAL_TOKEN|RUNNER_SERVICE_TOKEN|AI_MASTER_KEY' app public worker dist .next 2>/dev/null || true
echo "--- hidden canary bundle scan (must be empty) ---"
if rg -n 'HIDDEN_INPUT_CANARY|HOST_HIDDEN_CANARY' app public worker dist .next 2>/dev/null; then
  echo "hidden canary found" >&2
  exit 1
fi
echo "security static scan passed"
