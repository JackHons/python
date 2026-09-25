"""One-shot bounded JSON worker for a single Python execution job.

The process reads exactly one bounded JSON request from stdin and writes one
bounded JSON response to stdout.  It has no HTTP listener or service
credentials; the container entrypoint is intended to be launched per job.
"""

from __future__ import annotations

import json
import os
import queue
import selectors
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

try:  # Support both ``python job_worker.py`` and package imports in tests.
    from .execution_policy import (
        MAX_OUTPUT_BYTES,
        MAX_REQUEST_BYTES,
        MEMORY_BYTES,
        CHILD_PROCESS_COUNT,
        MAX_FILE_BYTES,
        PolicyError,
        JobRequest,
        validate_job_request,
    )
except ImportError:  # pragma: no cover - exercised by the Docker entrypoint
    from execution_policy import (  # type: ignore[no-redef]
        MAX_OUTPUT_BYTES,
        MAX_REQUEST_BYTES,
        MEMORY_BYTES,
        CHILD_PROCESS_COUNT,
        MAX_FILE_BYTES,
        PolicyError,
        JobRequest,
        validate_job_request,
    )


ROOT = Path(__file__).resolve().parent
WRAPPER = ROOT / "resource_wrapper.py"
MAX_ERROR_BYTES = 512


class WorkerProtocolError(ValueError):
    """The worker input or output protocol was invalid or exceeded a bound."""


def _kill_process_group(process: subprocess.Popen[bytes]) -> None:
    try:
        if hasattr(os, "killpg"):
            os.killpg(process.pid, signal.SIGKILL)
        elif process.poll() is None:
            process.kill()
    except ProcessLookupError:
        pass
    except (AttributeError, PermissionError, OSError):
        try:
            if process.poll() is None:
                process.kill()
        except ProcessLookupError:
            pass


def _collect_output_with_threads(
    process: subprocess.Popen[bytes], timeout_ms: int, max_output_bytes: int
) -> tuple[bytes, bytes, bool, bool]:
    """Bounded pipe collection for Windows, where selectors cannot read pipes."""
    assert process.stdout is not None
    assert process.stderr is not None
    events: queue.Queue[tuple[str, bytes | None]] = queue.Queue()
    stop_readers = threading.Event()

    def read_stream(name: str, stream: Any) -> None:
        try:
            while not stop_readers.is_set():
                try:
                    chunk = stream.read(8192)
                except (OSError, ValueError):
                    break
                if not chunk:
                    break
                events.put((name, chunk))
        finally:
            events.put((name, None))

    readers = [
        threading.Thread(target=read_stream, args=("stdout", process.stdout), daemon=True),
        threading.Thread(target=read_stream, args=("stderr", process.stderr), daemon=True),
    ]
    for reader in readers:
        reader.start()

    output = {"stdout": bytearray(), "stderr": bytearray()}
    total = 0
    open_streams = len(readers)
    deadline = time.monotonic() + timeout_ms / 1000
    termination_deadline: float | None = None
    timed_out = False
    output_limited = False

    try:
        while open_streams:
            now = time.monotonic()
            if now >= deadline and not timed_out:
                timed_out = True
                _kill_process_group(process)
                stop_readers.set()
                termination_deadline = now + 0.25
            if termination_deadline is not None and now >= termination_deadline:
                break

            next_deadline = termination_deadline or deadline
            try:
                name, chunk = events.get(timeout=max(0, min(0.05, next_deadline - now)))
            except queue.Empty:
                continue
            if chunk is None:
                open_streams -= 1
                continue

            available = max_output_bytes - total
            if available > 0:
                output[name].extend(chunk[:available])
                total += min(len(chunk), available)
            if len(chunk) > available:
                output_limited = True
                stop_readers.set()
                _kill_process_group(process)
                termination_deadline = termination_deadline or time.monotonic() + 0.25
    finally:
        stop_readers.set()
        if timed_out or output_limited:
            _kill_process_group(process)
        for stream in (process.stdout, process.stderr):
            try:
                stream.close()
            except (OSError, ValueError):
                pass
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            _kill_process_group(process)
            process.wait(timeout=1)
        for reader in readers:
            reader.join(timeout=1)

    return bytes(output["stdout"]), bytes(output["stderr"]), timed_out, output_limited


def _collect_output(
    process: subprocess.Popen[bytes], timeout_ms: int, max_output_bytes: int
) -> tuple[bytes, bytes, bool, bool]:
    if os.name == "nt":
        return _collect_output_with_threads(process, timeout_ms, max_output_bytes)

    selector = selectors.DefaultSelector()
    assert process.stdout is not None
    assert process.stderr is not None
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    os.set_blocking(process.stdout.fileno(), False)
    os.set_blocking(process.stderr.fileno(), False)
    output = {"stdout": bytearray(), "stderr": bytearray()}
    total = 0
    deadline = time.monotonic() + timeout_ms / 1000
    termination_deadline: float | None = None
    timed_out = False
    output_limited = False

    try:
        while selector.get_map():
            now = time.monotonic()
            if now >= deadline and not timed_out:
                timed_out = True
                _kill_process_group(process)
                termination_deadline = now + 0.25
            if termination_deadline is not None and now >= termination_deadline:
                break

            next_deadline = termination_deadline or deadline
            events = selector.select(timeout=max(0, min(0.05, next_deadline - now)))
            for key, _ in events:
                try:
                    chunk = os.read(key.fd, 8192)
                except BlockingIOError:
                    continue
                if not chunk:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                    continue

                available = max_output_bytes - total
                if available > 0:
                    output[key.data].extend(chunk[:available])
                    total += min(len(chunk), available)
                if len(chunk) > available:
                    output_limited = True
                    _kill_process_group(process)
                    termination_deadline = termination_deadline or time.monotonic() + 0.25
    finally:
        for key in list(selector.get_map().values()):
            key.fileobj.close()
        selector.close()
        if timed_out or output_limited:
            _kill_process_group(process)
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            _kill_process_group(process)
            process.wait(timeout=1)

    return bytes(output["stdout"]), bytes(output["stderr"]), timed_out, output_limited


def _child_env(scratch_path: Path, timeout_ms: int) -> dict[str, str]:
    """Build the same positive environment allowlist used by server.py."""
    return {
        "HOME": str(scratch_path),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "MPLBACKEND": "Agg",
        "MPLCONFIGDIR": str(scratch_path / ".matplotlib"),
        "OPENBLAS_NUM_THREADS": "1",
        "OMP_NUM_THREADS": "1",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1",
        "TMPDIR": str(scratch_path),
        "XDG_CACHE_HOME": str(scratch_path / ".cache"),
        "RUNNER_CHILD_CPU_MS": str(timeout_ms),
        "RUNNER_CHILD_MEMORY_BYTES": str(MEMORY_BYTES),
        "RUNNER_CHILD_FILE_BYTES": str(MAX_FILE_BYTES),
        "RUNNER_CHILD_PROCESS_COUNT": str(CHILD_PROCESS_COUNT),
    }


def execute_local_process(job: JobRequest) -> dict[str, Any]:
    """Execute one job with the existing bounded local-process behavior."""
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="python-job-") as temp_dir_name:
        temp_dir = Path(temp_dir_name)
        script_path = temp_dir / "main.py"
        stdin_path = temp_dir / "stdin.txt"
        scratch_path = temp_dir / "scratch"
        script_path.write_text(job.code, encoding="utf-8")
        with stdin_path.open("w", encoding="utf-8", newline="") as stdin_file:
            stdin_file.write(job.stdin)
        scratch_path.mkdir(mode=0o700)

        os.chmod(temp_dir, 0o711)
        os.chmod(script_path, 0o400)
        os.chmod(stdin_path, 0o400)
        command = [sys.executable, "-I", str(WRAPPER), str(script_path)]
        child_env = _child_env(scratch_path, job.timeout_ms)

        with stdin_path.open("rb") as stdin_file:
            process = subprocess.Popen(
                command,
                cwd=scratch_path,
                env=child_env,
                stdin=stdin_file,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                shell=False,
                start_new_session=True,
            )
            stdout, stderr, timed_out, output_limited = _collect_output(
                process, job.timeout_ms, MAX_OUTPUT_BYTES
            )

    return {
        "stdout": stdout.decode("utf-8", errors="replace").replace("\r\n", "\n"),
        "stderr": stderr.decode("utf-8", errors="replace").replace("\r\n", "\n"),
        "exit_code": process.returncode,
        "timed_out": timed_out,
        "output_limited": output_limited,
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


def _read_request() -> Any:
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        raise WorkerProtocolError("Request body is too large")
    if not raw:
        raise WorkerProtocolError("A non-empty request body is required")
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise WorkerProtocolError("Request body must be valid UTF-8 JSON") from exc


def _bounded_error(message: str) -> dict[str, str]:
    encoded = message.encode("utf-8")[:MAX_ERROR_BYTES]
    return {"error": encoded.decode("utf-8", errors="ignore")}


def _write_response(payload: dict[str, Any]) -> None:
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.write(b"\n")
    sys.stdout.buffer.flush()


def main() -> int:
    try:
        job = validate_job_request(_read_request())
        _write_response(execute_local_process(job))
        return 0
    except (PolicyError, WorkerProtocolError) as exc:
        _write_response(_bounded_error(str(exc)))
        return 2
    except Exception:
        # Keep internal details and submitted source out of the protocol.
        _write_response(_bounded_error("execution failed"))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
