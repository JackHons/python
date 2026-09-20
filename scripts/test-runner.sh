#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir/services/runner"

RUNNER_DROP_PRIVILEGES=0 python3 -m unittest discover -s tests -p 'test_*.py' -v
