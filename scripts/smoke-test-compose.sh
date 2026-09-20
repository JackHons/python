#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

curl --fail --silent --show-error "http://127.0.0.1:${WEB_PORT:-3000}/" >/dev/null

api_status=$(curl --silent --output /dev/null --write-out "%{http_code}" "http://127.0.0.1:${WEB_PORT:-3000}/api/v1/me")
[ "$api_status" = "401" ]

docker compose exec -T backend node -e "fetch('http://127.0.0.1:8787/ready').then(async response => { if (!response.ok) throw new Error('backend readiness failed: ' + response.status); const body = await response.json(); if (body.status !== 'ok' || body.foreignKeys !== 1 || body.database !== 'ok') throw new Error('backend readiness contract failed'); }).catch(error => { console.error(error.message); process.exit(1); })"

legacy_status=$(curl --silent --output /dev/null --write-out "%{http_code}" -X POST -H "content-type: application/json" --data '{"code":"print(1)"}' "http://127.0.0.1:${WEB_PORT:-3000}/api/run")
[ "$legacy_status" = "404" ]

docker compose exec -T runner python -c "import json, os, urllib.request; code=\"import numpy, pandas, matplotlib\\nprint('runner-ok')\"; request=urllib.request.Request('http://127.0.0.1:8080/execute', data=json.dumps({'code': code, 'timeout_ms': 5000, 'allowed_packages': ['numpy', 'pandas', 'matplotlib']}).encode(), headers={'Content-Type':'application/json','Authorization':'Bearer ' + os.environ['RUNNER_SERVICE_TOKEN']}); result=json.load(urllib.request.urlopen(request, timeout=8)); assert result['stdout'] == 'runner-ok\\n' and result['exit_code'] == 0, result"

gateway_health=$(curl --fail --silent --show-error "http://127.0.0.1:${WEB_PORT:-3000}/health")
echo "$gateway_health" | grep -q '"status":"ok"'

echo "Gateway/web, backend readiness, authenticated-API gate, legacy-route gate, and Python runner smoke tests passed."
