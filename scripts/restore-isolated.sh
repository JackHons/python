#!/bin/sh
set -eu

backup_id=${1:-}
target_dir=${2:-}
if [ -z "$backup_id" ] || [ -z "$target_dir" ]; then
  echo "usage: $0 BACKUP_ID EMPTY_TARGET_DIRECTORY" >&2
  exit 2
fi
case "$target_dir" in
  ""|/|.|..|./|../) echo "refusing broad restore target" >&2; exit 2;;
esac
exec node --experimental-strip-types scripts/restore-isolated.mjs "$backup_id" "$target_dir"
