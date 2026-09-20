#!/usr/bin/env python3
"""Host-only Runner smoke/load evidence.

This uses the documented insecure local-test override because a macOS host
process cannot use the Linux sandbox UID contract. It proves HTTP validation,
AST policy, timeout/output limits, and bounded 429 behaviour only; it does not
prove Docker network/cgroup isolation.
"""
from __future__ import annotations

import concurrent.futures
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PORT = int(os.environ.get("PHASE8_RUNNER_PORT", "18080"))
TOKEN = "phase8-host-runner-token-123456789"
REPORT = ROOT / "docs/任務包/證據/phase8-runner-host.json"
ENV = os.environ.copy()
ENV.update({
    "RUNNER_HOST": "127.0.0.1", "RUNNER_PORT": str(PORT),
    "RUNNER_SERVICE_TOKEN": TOKEN, "RUNNER_DROP_PRIVILEGES": "0",
    "RUNNER_ALLOW_INSECURE_NO_PRIVILEGE_DROP": "1", "RUNNER_MAX_CONCURRENCY": "4",
    "RUNNER_DEFAULT_TIMEOUT_MS": "100", "RUNNER_MAX_TIMEOUT_MS": "200",
    "RUNNER_MAX_OUTPUT_BYTES": "1024", "RUNNER_REQUEST_TIMEOUT_MS": "1000",
})

def request(path: str, payload: dict | None = None, auth: bool = True) -> tuple[int, dict]:
    data = None if payload is None else json.dumps(payload).encode()
    headers = {"Authorization": f"Bearer {TOKEN}"} if auth else {}
    if data is not None:
        headers["Content-Type"] = "application/json"
    try:
        with urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=data, headers=headers), timeout=4) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())

process = subprocess.Popen([sys.executable, "services/runner/server.py"], cwd=ROOT, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    deadline = time.time() + 8
    while time.time() < deadline:
        try:
            if request("/health")[0] == 200:
                break
        except Exception:
            time.sleep(0.1)
    else:
        raise RuntimeError("runner did not become healthy")
    checks = {
        "health": request("/health")[0] == 200,
        "unauthorized": request("/execute", {"code": "print('x')"}, auth=False)[0] == 401,
        "network_policy": request("/execute", {"code": "import socket"})[0] in (400, 422),
        "subprocess_policy": request("/execute", {"code": "import subprocess"})[0] in (400, 422),
        "pip_policy": request("/execute", {"code": "import pip"})[0] in (400, 422),
        "timeout": request("/execute", {"code": "while True: pass", "timeout_ms": 100})[1].get("timed_out") is True,
        "output_limit": request("/execute", {"code": "print('x' * 5000)"})[1].get("output_limited") is True,
    }
    def run_one(index: int) -> tuple[int, dict]:
        return request("/execute", {"code": f"print({index})", "timeout_ms": 100})
    with concurrent.futures.ThreadPoolExecutor(max_workers=40) as pool:
        responses = list(pool.map(run_one, range(40)))
    status_counts: dict[str, int] = {}
    for status, _payload in responses:
        status_counts[str(status)] = status_counts.get(str(status), 0) + 1
    checks["bounded_queue_observed"] = any(status == 429 for status, _ in responses)
    report = {"scenario": "host-runner-malicious-and-40-concurrent", "checks": checks, "statusCounts": status_counts, "successfulResponses": sum(status == 200 for status, _ in responses), "note": "Host process with insecure no-privilege-drop override; Docker network/cgroup/ARM64 isolation is not verified."}
    REPORT.parent.mkdir(parents=True, exist_ok=True)
    REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
finally:
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
