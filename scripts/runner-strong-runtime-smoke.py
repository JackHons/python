#!/usr/bin/env python3
"""Black-box smoke and bounded-load checks for a running strong Runner.

This script talks only to the Runner HTTP contract. It does not invoke Docker,
inspect host files, or print submitted source. The host launcher and runtime
remain outside the test process by design.
"""

from __future__ import annotations

import concurrent.futures
import json
import os
import statistics
import sys
import time
from dataclasses import dataclass
from urllib import error, request


DEFAULT_URL = "http://127.0.0.1:8080"
DEFAULT_JOBS = 40


@dataclass(frozen=True)
class HttpResult:
    status: int
    payload: dict[str, object]
    duration_ms: float


def _request(base_url: str, token: str, path: str, body: dict[str, object] | None = None) -> HttpResult:
    started = time.monotonic()
    data = None
    headers = {"Authorization": f"Bearer {token}"}
    method = "GET"
    if body is not None:
        data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
        method = "POST"
    req = request.Request(
        f"{base_url.rstrip('/')}{path}",
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with request.urlopen(req, timeout=15) as response:
            payload = json.loads(response.read())
            return HttpResult(response.status, payload, (time.monotonic() - started) * 1000)
    except error.HTTPError as exc:
        payload = json.loads(exc.read())
        return HttpResult(exc.code, payload, (time.monotonic() - started) * 1000)


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _run_job(base_url: str, token: str, marker: str) -> HttpResult:
    return _request(
        base_url,
        token,
        "/execute",
        {
            "code": "print(input())",
            "stdin": f"{marker}\n",
            "timeout_ms": 5000,
            "allowed_packages": [],
        },
    )


def main() -> int:
    base_url = os.environ.get("RUNNER_SMOKE_URL", DEFAULT_URL)
    token = os.environ.get("RUNNER_SMOKE_TOKEN", "")
    if len(token) < 24:
        print("RUNNER_SMOKE_TOKEN must contain at least 24 characters", file=sys.stderr)
        return 2
    jobs = int(os.environ.get("RUNNER_SMOKE_JOBS", str(DEFAULT_JOBS)))
    if jobs < 1 or jobs > 100:
        print("RUNNER_SMOKE_JOBS must be between 1 and 100", file=sys.stderr)
        return 2

    ready = _request(base_url, token, "/ready")
    _assert(ready.status == 200, "strong Runner is not ready")
    _assert(ready.payload.get("ready") is True, "Runner readiness is false")
    isolation = ready.payload.get("isolation")
    _assert(isinstance(isolation, dict), "readiness omitted isolation facts")
    _assert(isolation.get("strong_verified") is True, "strong runtime is not verified")

    basic = _run_job(base_url, token, "strong-smoke")
    _assert(basic.status == 200 and basic.payload.get("stdout") == "strong-smoke\n", "basic job failed")

    numpy_job = _request(
        base_url,
        token,
        "/execute",
        {
            "code": "import numpy as np\nprint(int(np.array([2, 3]).sum()))",
            "stdin": "",
            "timeout_ms": 5000,
            "allowed_packages": ["numpy"],
        },
    )
    _assert(numpy_job.status == 200 and numpy_job.payload.get("stdout") == "5\n", "numpy job failed")

    timeout = _request(
        base_url,
        token,
        "/execute",
        {"code": "while True: pass", "stdin": "", "timeout_ms": 100},
    )
    _assert(timeout.status == 503, "timeout did not fail closed")
    _assert(timeout.payload.get("code") == "runner_not_ready", "timeout error was not sanitized")

    policy = _request(
        base_url,
        token,
        "/execute",
        {"code": "import socket", "stdin": "", "timeout_ms": 1000},
    )
    _assert(policy.status == 422, "blocked network capability was not rejected")

    def run(index: int) -> HttpResult:
        return _run_job(base_url, token, f"job-{index}")

    workers = int(os.environ.get("RUNNER_SMOKE_WORKERS", "2"))
    if workers < 1 or workers > 8:
        print("RUNNER_SMOKE_WORKERS must be between 1 and 8", file=sys.stderr)
        return 2
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        load_results = list(pool.map(run, range(jobs)))
    accepted = [result for result in load_results if result.status == 200]
    rejected = [result for result in load_results if result.status != 200]
    _assert(accepted, "no load jobs were accepted")
    _assert(
        all(result.status == 429 for result in rejected),
        "load produced an unexpected non-busy failure",
    )
    for index, result in enumerate(load_results):
        if result.status == 200:
            _assert(result.payload.get("stdout") == f"job-{index}\n", f"job {index} result mismatch")

    durations = [result.duration_ms for result in load_results]
    report = {
        "ready": True,
        "strong_verified": True,
        "basic": "pass",
        "numpy": "pass",
        "timeout_fail_closed": "pass",
        "blocked_network_policy": "pass",
        "jobs": jobs,
        "accepted": len(accepted),
        "busy_rejected": len(rejected),
        "workers": workers,
        "p50_ms": round(statistics.median(durations), 2),
        "max_ms": round(max(durations), 2),
    }
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
