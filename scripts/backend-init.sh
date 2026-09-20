#!/bin/sh
set -eu

# Backend startup already opens the configured SQLite database and applies the
# tracked migration contract. This wrapper is intentionally idempotent and
# does not print credentials or seed passwords.
exec npm run backend
