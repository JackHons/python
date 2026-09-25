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
        with request.urlopen(req, timeout=20) as response:
            payload = json.loads(response.read())
            return HttpResult(response.status, payload, (time.monotonic() - started) * 1000)
    except error.HTTPError as exc:
        payload = json.loads(exc.read())
        return HttpResult(exc.code, payload, (time.monotonic() - started) * 1000)
    except (error.URLError, TimeoutError):
        return HttpResult(599, {"error": "transport_failed"}, (time.monotonic() - started) * 1000)


def _assert(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def _execute(
    base_url: str,
    token: str,
    code: str,
    *,
    stdin: str = "",
    timeout_ms: int = 5000,
    allowed_packages: list[str] | None = None,
) -> HttpResult:
    return _request(
        base_url,
        token,
        "/execute",
        {
            "code": code,
            "stdin": stdin,
            "timeout_ms": timeout_ms,
            "allowed_packages": allowed_packages or [],
        },
    )


def _run_job(base_url: str, token: str, marker: str) -> HttpResult:
    return _execute(base_url, token, "print(input())", stdin=f"{marker}\n")


def _assert_result(result: HttpResult, message: str) -> None:
    _assert(result.status == 200, f"{message}: HTTP {result.status}")
    _assert("error" not in result.payload, f"{message}: error response")


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

    numpy_job = _execute(
        base_url,
        token,
        "import numpy as np\nprint(int(np.array([2, 3]).sum()))",
        allowed_packages=["numpy"],
    )
    _assert(numpy_job.status == 200 and numpy_job.payload.get("stdout") == "5\n", "numpy job failed")

    pandas_job = _execute(
        base_url,
        token,
        "import pandas as pd\nprint(int(pd.DataFrame({'x': [1, 2]}).x.sum()))",
        allowed_packages=["pandas"],
    )
    _assert(pandas_job.status == 200 and pandas_job.payload.get("stdout") == "3\n", "pandas job failed")

    matplotlib_job = _execute(
        base_url,
        token,
        "import matplotlib\nprint(matplotlib.get_backend().lower())",
        allowed_packages=["matplotlib"],
    )
    _assert(
        matplotlib_job.status == 200 and matplotlib_job.payload.get("stdout") == "agg\n",
        "matplotlib Agg job failed",
    )

    timeout = _request(
        base_url,
        token,
        "/execute",
        {"code": "while True: pass", "stdin": "", "timeout_ms": 100},
    )
    _assert(timeout.status == 200, "student timeout was not returned as a normal result")
    _assert(timeout.payload.get("timed_out") is True, "student timeout flag was not preserved")

    egress = _execute(
        base_url,
        token,
        "import smtplib\n"
        "try:\n"
        "    smtplib.SMTP('1.1.1.1', 25, timeout=1)\n"
        "    print('egress-open')\n"
        "except Exception:\n"
        "    print('egress-blocked')\n",
        timeout_ms=3000,
    )
    _assert(
        egress.status == 200 and egress.payload.get("stdout") == "egress-blocked\n",
        "permitted-code egress canary was not blocked",
    )

    policy = _request(
        base_url,
        token,
        "/execute",
        {"code": "import socket", "stdin": "", "timeout_ms": 1000},
    )
    _assert(policy.status == 422, "blocked network capability was not rejected")

    filesystem = _execute(
        base_url,
        token,
        "targets = ['/workspace/learning-platform-host-canary', '/repo/.git/config', '/data/learning.sqlite']\n"
        "states = []\n"
        "for target in targets:\n"
        "    try:\n"
        "        open(target, 'rb').read(1)\n"
        "        states.append('open')\n"
        "    except OSError:\n"
        "        states.append('blocked')\n"
        "print(','.join(states))\n",
    )
    _assert(
        filesystem.status == 200 and filesystem.payload.get("stdout") == "blocked,blocked,blocked\n",
        "host/repository/data canary was accessible",
    )

    environment = _execute(
        base_url,
        token,
        "names = [b'RUNNER_SERVICE_TOKEN', b'PYTHON_RUNNER_TOKEN', b'BACKEND_INTERNAL_TOKEN', "
        "b'AI_MASTER_KEY', b'SMTP_PASSWORD', b'SMTP_USERNAME']\n"
        "try:\n"
        "    data = open('/proc/self/environ', 'rb').read()\n"
        "except OSError:\n"
        "    data = b''\n"
        "print('secrets-present' if any(name + b'=' in data for name in names) else 'secrets-absent')\n",
    )
    _assert(
        environment.status == 200 and environment.payload.get("stdout") == "secrets-absent\n",
        "runner environment exposed a service secret",
    )

    marker_path = "/tmp/runner-slice-b-cross-job-marker"
    state_writer = _execute(
        base_url,
        token,
        f"open({marker_path!r}, 'w').write('present')\nprint('written')\n",
    )
    _assert(state_writer.status == 200 and state_writer.payload.get("stdout") == "written\n", "state writer failed")
    state_reader = _execute(
        base_url,
        token,
        f"\ntry:\n    open({marker_path!r}, 'rb').read()\n    print('state-leaked')\nexcept OSError:\n    print('state-isolated')\n",
    )
    _assert(
        state_reader.status == 200 and state_reader.payload.get("stdout") == "state-isolated\n",
        "cross-job state was not isolated",
    )

    runtime_error = _execute(base_url, token, "raise RuntimeError('smoke-runtime-error')")
    _assert_result(runtime_error, "runtime-error cleanup job failed at broker")
    _assert(runtime_error.payload.get("exit_code") not in (0, None), "runtime error was hidden")

    memory_pressure = _execute(
        base_url,
        token,
        "blob = bytearray(450 * 1024 * 1024)\nprint(len(blob))\n",
        timeout_ms=3000,
    )
    _assert(
        memory_pressure.status in {200, 503},
        f"memory pressure returned unexpected HTTP {memory_pressure.status}",
    )
    if memory_pressure.status == 200:
        _assert(memory_pressure.payload.get("exit_code") not in (0, None), "memory limit was not enforced")

    pid_pressure = _execute(
        base_url,
        token,
        "import threading\n"
        "threads = [threading.Thread(target=lambda: None) for _ in range(256)]\n"
        "started = 0\n"
        "for thread in threads:\n"
        "    try:\n"
        "        thread.start()\n"
        "        started += 1\n"
        "    except RuntimeError:\n"
        "        break\n"
        "for thread in threads[:started]:\n"
        "    thread.join()\n"
        "print('pid-pressure-bounded')\n",
        timeout_ms=3000,
    )
    _assert(
        pid_pressure.status == 200 and pid_pressure.payload.get("stdout") == "pid-pressure-bounded\n",
        "PID pressure was not bounded",
    )

    cleanup_probe = _run_job(base_url, token, "post-adversarial-cleanup")
    _assert(
        cleanup_probe.status == 200 and cleanup_probe.payload.get("stdout") == "post-adversarial-cleanup\n",
        "runner did not recover after adversarial jobs",
    )

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
        "pandas": "pass",
        "matplotlib_agg": "pass",
        "student_timeout_normal_result": "pass",
        "egress_blocked": "pass",
        "blocked_network_policy": "pass",
        "host_repo_data_blocked": "pass",
        "secrets_absent": "pass",
        "cross_job_isolation": "pass",
        "runtime_error_cleanup": "pass",
        "memory_pressure_bounded": "pass",
        "pid_pressure_bounded": "pass",
        "post_adversarial_cleanup": "pass",
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
