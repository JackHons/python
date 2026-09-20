#!/bin/sh
set -eu

# Never pipe raw production logs to a report. This filter is deliberately
# conservative and replaces common credential-shaped fields before output.
exec sed -E 's/(BACKEND_INTERNAL_TOKEN|RUNNER_SERVICE_TOKEN|AI_MASTER_KEY|password|token|api[_-]?key)([=:][^,[:space:]}]+)/\1=[REDACTED]/Ig'
