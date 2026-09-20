"""Apply per-process resource limits before evaluating a submitted script."""

from __future__ import annotations

import math
import os
import resource
import runpy
import sys


def _positive_int(name: str) -> int:
    value = int(os.environ[name])
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def apply_limits() -> None:
    cpu_seconds = max(1, math.ceil(_positive_int("RUNNER_CHILD_CPU_MS") / 1000))
    memory_bytes = _positive_int("RUNNER_CHILD_MEMORY_BYTES")
    file_bytes = _positive_int("RUNNER_CHILD_FILE_BYTES")
    process_count = _positive_int("RUNNER_CHILD_PROCESS_COUNT")

    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
    # macOS reports RLIMIT_AS but rejects lowering it for the framework Python
    # used by the host-only unit tests. Linux (the actual runner container)
    # enforces it normally; Docker also adds a container-wide memory ceiling.
    if sys.platform != "darwin":
        resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))
    resource.setrlimit(resource.RLIMIT_FSIZE, (file_bytes, file_bytes))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    resource.setrlimit(resource.RLIMIT_NPROC, (process_count, process_count))


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: resource_wrapper.py SCRIPT")
    apply_limits()
    runpy.run_path(sys.argv[1], run_name="__main__")


if __name__ == "__main__":
    main()
