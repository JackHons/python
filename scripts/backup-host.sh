#!/bin/sh
set -eu

exec node --experimental-strip-types scripts/backup-host.mjs
