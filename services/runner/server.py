"""Small internal HTTP service for constrained, single-file Python execution.

This is an MVP isolation layer. The Docker container is the security boundary;
production use still requires a disposable per-job sandbox runtime.
"""

from __future__ import annotations

import json
import ast
import importlib.util
import os
import queue
import secrets
import selectors
import signal
import socket
import subprocess
import sys
import sysconfig
import tempfile
import threading
import time
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
WRAPPER = ROOT / "resource_wrapper.py"

FORBIDDEN_IMPORTS = {
    "asyncio",
    "ctypes",
    "ensurepip",
    "ftplib",
    "http",
    "multiprocessing",
    "os",
    "pathlib",
    "pip",
    "requests",
    "resource",
    "shutil",
    "signal",
    "socket",
    "ssl",
    "subprocess",
    "telnetlib",
    "urllib",
    "webbrowser",
}
FORBIDDEN_CALLS = {
    "__import__",
    "breakpoint",
    "compile",
    "create_subprocess_exec",
    "create_subprocess_shell",
    "eval",
    "exec",
    "fork",
    "forkpty",
    "popen",
    "system",
}
SUPPORTED_PACKAGES = {"numpy", "pandas", "matplotlib"}
ISOLATION_MODE_LOCAL_PROCESS = "local_process"
ISOLATION_MODE_STRONG_EXTERNAL = "strong_external"
ISOLATION_MODES = frozenset({ISOLATION_MODE_LOCAL_PROCESS, ISOLATION_MODE_STRONG_EXTERNAL})
EXECUTE_REQUEST_FIELDS = frozenset({"code", "stdin", "timeout_ms", "allowed_packages"})
SECRET_ENV_NAMES = frozenset(
    {
        "RUNNER_SERVICE_TOKEN",
        "PYTHON_RUNNER_TOKEN",
        "BACKEND_INTERNAL_TOKEN",
        "AI_MASTER_KEY",
        "SMTP_PASSWORD",
        "SMTP_USERNAME",
    }
)


def _path_is_within(path: Path, root: Path) -> bool:
    """Python 3.9-compatible equivalent of Path.is_relative_to()."""
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _stdlib_paths() -> tuple[tuple[Path, ...], tuple[Path, ...]]:
    standard: list[Path] = []
    third_party: list[Path] = []
    for key in ("stdlib", "platstdlib"):
        value = sysconfig.get_path(key)
        if value:
            path = Path(value).resolve()
            if path not in standard:
                standard.append(path)
    for key in ("purelib", "platlib"):
        value = sysconfig.get_path(key)
        if value:
            path = Path(value).resolve()
            if path not in third_party:
                third_party.append(path)
    return tuple(standard), tuple(third_party)


STDLIB_PATHS, THIRD_PARTY_PATHS = _stdlib_paths()


def _has_third_party_path_component(path: Path) -> bool:
    """Reject package-manager directories even when nested under stdlib.

    Some Python distributions place vendor paths below the interpreter's
    stdlib root without reporting that exact directory as purelib/platlib.
    Treating the whole stdlib root as trusted would then promote arbitrary
    installed modules to standard-library status.
    """
    return any(part.casefold() in {"site-packages", "dist-packages"} for part in path.parts)


def is_stdlib_module(name: str) -> bool:
    """Return true only for modules provided by this Python installation.

    Python 3.10+ exposes ``sys.stdlib_module_names``.  Python 3.9 does not, so
    the fallback accepts built-in/frozen modules and modules whose resolved
    import location is inside the interpreter's stdlib directories while
    explicitly excluding purelib/platlib (normally site-packages).  Arbitrary
    entries on sys.path are therefore never promoted to standard-library
    status.
    """
    if name in sys.builtin_module_names:
        return True
    known_names = getattr(sys, "stdlib_module_names", None)
    if known_names is not None and name not in known_names:
        return False
    try:
        spec = importlib.util.find_spec(name)
    except (AttributeError, ImportError, ModuleNotFoundError, ValueError):
        return False
    if spec is None:
        return False
    if spec.origin in {"built-in", "frozen"}:
        return True
    candidates = []
    if spec.origin:
        candidates.append(Path(spec.origin).resolve())
    if spec.submodule_search_locations:
        candidates.extend(Path(value).resolve() for value in spec.submodule_search_locations)
    return bool(candidates) and all(
        not _has_third_party_path_component(candidate)
        and
        any(_path_is_within(candidate, root) for root in STDLIB_PATHS)
        and not any(_path_is_within(candidate, root) for root in THIRD_PARTY_PATHS)
        for candidate in candidates
    )


def _env_int(name: str, default: int, minimum: int = 1) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if value < minimum:
        raise RuntimeError(f"{name} must be at least {minimum}")
    return value


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "1" if default else "0").strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    raise RuntimeError(f"{name} must be a boolean")


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    max_request_bytes: int
    max_code_bytes: int
    max_input_bytes: int
    max_output_bytes: int
    max_timeout_ms: int
    default_timeout_ms: int
    max_concurrency: int
    memory_bytes: int
    max_file_bytes: int
    child_process_count: int
    sandbox_uid: int
    sandbox_gid: int
    drop_privileges: bool
    request_timeout_ms: int
    service_token: str
    isolation_mode: str
    require_strong_isolation: bool

    @classmethod
    def from_env(cls) -> "Settings":
        isolation_mode = os.environ.get(
            "RUNNER_ISOLATION_MODE", ISOLATION_MODE_LOCAL_PROCESS
        ).strip().lower()
        if isolation_mode not in ISOLATION_MODES:
            allowed = ", ".join(sorted(ISOLATION_MODES))
            raise RuntimeError(f"RUNNER_ISOLATION_MODE must be one of: {allowed}")
        require_strong_isolation = _env_bool("RUNNER_REQUIRE_STRONG_ISOLATION", False)
        max_timeout_ms = _env_int("RUNNER_MAX_TIMEOUT_MS", 5000, 100)
        default_timeout_ms = min(
            _env_int("RUNNER_DEFAULT_TIMEOUT_MS", 3000, 100), max_timeout_ms
        )
        service_token = os.environ.get("RUNNER_SERVICE_TOKEN", "").strip()
        if len(service_token) < 24:
            raise RuntimeError("RUNNER_SERVICE_TOKEN must contain at least 24 characters")
        return cls(
            host=os.environ.get("RUNNER_HOST", "0.0.0.0"),
            port=_env_int("RUNNER_PORT", 8080),
            max_request_bytes=_env_int("RUNNER_MAX_REQUEST_BYTES", 196608),
            max_code_bytes=_env_int("RUNNER_MAX_CODE_BYTES", 102400),
            max_input_bytes=_env_int("RUNNER_MAX_INPUT_BYTES", 65536),
            max_output_bytes=_env_int("RUNNER_MAX_OUTPUT_BYTES", 65536),
            max_timeout_ms=max_timeout_ms,
            default_timeout_ms=default_timeout_ms,
            max_concurrency=_env_int("RUNNER_MAX_CONCURRENCY", 4),
            memory_bytes=_env_int("RUNNER_MEMORY_MB", 768) * 1024 * 1024,
            max_file_bytes=_env_int("RUNNER_MAX_FILE_BYTES", 5 * 1024 * 1024),
            child_process_count=_env_int("RUNNER_CHILD_PROCESS_COUNT", 128),
            sandbox_uid=_env_int("RUNNER_SANDBOX_UID", 10001),
            sandbox_gid=_env_int("RUNNER_SANDBOX_GID", 10001),
            drop_privileges=_env_bool("RUNNER_DROP_PRIVILEGES", True),
            request_timeout_ms=_env_int("RUNNER_REQUEST_TIMEOUT_MS", 3000, 250),
            service_token=service_token,
            isolation_mode=isolation_mode,
            require_strong_isolation=require_strong_isolation,
        )


SETTINGS = Settings.from_env()
EXECUTION_IDENTITIES: queue.LifoQueue[tuple[int, int]] = queue.LifoQueue(
    SETTINGS.max_concurrency
)
for identity_offset in range(SETTINGS.max_concurrency):
    EXECUTION_IDENTITIES.put(
        (
            SETTINGS.sandbox_uid + identity_offset,
            SETTINGS.sandbox_gid + identity_offset,
        )
    )


class RequestError(Exception):
    def __init__(self, status: HTTPStatus, message: str) -> None:
        super().__init__(message)
        self.status = status


class CodePolicyError(ValueError):
    """The submitted source requests a capability outside the runner policy."""


class RunnerNotReady(RuntimeError):
    """The configured isolation policy cannot safely execute a job."""


@dataclass(frozen=True)
class IsolationPolicy:
    """Server-owned isolation policy and the verified executor facts."""

    mode: str
    require_strong: bool
    executor_available: bool
    strong_executor_verified: bool

    @property
    def strong_required(self) -> bool:
        return self.require_strong or self.mode == ISOLATION_MODE_STRONG_EXTERNAL

    @property
    def ready(self) -> bool:
        if self.mode == ISOLATION_MODE_LOCAL_PROCESS:
            return self.executor_available and not self.require_strong
        return (
            self.executor_available
            and self.strong_executor_verified
            and self.strong_required
        )


def validate_allowed_packages(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list) or any(
        not isinstance(item, str) or item not in SUPPORTED_PACKAGES for item in value
    ):
        raise CodePolicyError("allowed_packages contains an unsupported package")
    return tuple(dict.fromkeys(value))


def validate_code_policy(code: str, allowed_packages: tuple[str, ...] = ()) -> None:
    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError:
        # Syntax errors are reported by the child interpreter, not treated as
        # a policy violation.
        return
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names = [alias.name.split(".", 1)[0] for alias in node.names]
            if any(name in FORBIDDEN_IMPORTS for name in names):
                raise CodePolicyError("code uses a blocked capability")
            if any(not is_stdlib_module(name) and name not in allowed_packages for name in names):
                raise CodePolicyError("code imports a package that is not enabled for this course")
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".", 1)[0]
            if root in FORBIDDEN_IMPORTS:
                raise CodePolicyError("code uses a blocked capability")
            if root and not is_stdlib_module(root) and root not in allowed_packages:
                raise CodePolicyError("code imports a package that is not enabled for this course")
        elif isinstance(node, ast.Call):
            function_name = node.func.id if isinstance(node.func, ast.Name) else (
                node.func.attr if isinstance(node.func, ast.Attribute) else ""
            )
            if function_name in FORBIDDEN_CALLS:
                raise CodePolicyError("code uses a blocked capability")


def _kill_process_group(process: subprocess.Popen[bytes]) -> None:
    try:
        if hasattr(os, "killpg"):
            os.killpg(process.pid, signal.SIGKILL)
        elif process.poll() is None:
            process.kill()
    except ProcessLookupError:
        pass
    except (AttributeError, PermissionError, OSError):
        # Some host Python builds cannot signal a newly-created process group.
        # The Linux container retains CAP_KILL so the group path is used there;
        # killing the direct child keeps host-only tests deterministic.
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
        _kill_process_group(process) if (timed_out or output_limited) else None
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            _kill_process_group(process)
            process.wait(timeout=1)

    return bytes(output["stdout"]), bytes(output["stderr"]), timed_out, output_limited


def build_child_env(settings: Settings, scratch_path: Path, timeout_ms: int) -> dict[str, str]:
    """Build a positive-allowlist environment for student code."""
    child_env = {
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
        "RUNNER_CHILD_MEMORY_BYTES": str(settings.memory_bytes),
        "RUNNER_CHILD_FILE_BYTES": str(settings.max_file_bytes),
        "RUNNER_CHILD_PROCESS_COUNT": str(settings.child_process_count),
    }
    if SECRET_ENV_NAMES.intersection(child_env):
        raise RuntimeError("secret environment names are not allowed in child environment")
    return child_env


def _execute_python_local(
    settings: Settings,
    code: str,
    stdin_text: str,
    timeout_ms: int,
    sandbox_uid: int | None = None,
    sandbox_gid: int | None = None,
    allowed_packages: tuple[str, ...] = (),
) -> dict[str, Any]:
    validate_code_policy(code, allowed_packages)
    started = time.monotonic()
    child_uid = sandbox_uid if sandbox_uid is not None else settings.sandbox_uid
    child_gid = sandbox_gid if sandbox_gid is not None else settings.sandbox_gid
    with tempfile.TemporaryDirectory(prefix="python-job-") as temp_dir_name:
        temp_dir = Path(temp_dir_name)
        script_path = temp_dir / "main.py"
        stdin_path = temp_dir / "stdin.txt"
        scratch_path = temp_dir / "scratch"
        script_path.write_text(code, encoding="utf-8")
        with stdin_path.open("w", encoding="utf-8", newline="") as stdin_file:
            stdin_file.write(stdin_text)
        scratch_path.mkdir(mode=0o700)

        os.chmod(temp_dir, 0o711)
        os.chmod(script_path, 0o400)
        os.chmod(stdin_path, 0o400)

        command = [sys.executable, "-I", str(WRAPPER), str(script_path)]
        if settings.drop_privileges:
            if not hasattr(os, "geteuid") or os.geteuid() != 0:
                raise RuntimeError("privilege dropping requires the runner service to start as root")
            os.chown(script_path, child_uid, child_gid)
            os.chown(scratch_path, child_uid, child_gid)
            command = [
                "/usr/bin/setpriv",
                f"--reuid={child_uid}",
                f"--regid={child_gid}",
                "--clear-groups",
                "--no-new-privs",
                *command,
            ]

        child_env = build_child_env(settings, scratch_path, timeout_ms)

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
                process, timeout_ms, settings.max_output_bytes
            )

    return {
        # The public runner protocol uses LF regardless of the host OS.
        "stdout": stdout.decode("utf-8", errors="replace").replace("\r\n", "\n"),
        "stderr": stderr.decode("utf-8", errors="replace").replace("\r\n", "\n"),
        "exit_code": process.returncode,
        "timed_out": timed_out,
        "output_limited": output_limited,
        "duration_ms": round((time.monotonic() - started) * 1000),
    }


class LocalProcessExecutor:
    """The bounded but weak local process executor used for local/internal runs."""

    mode = ISOLATION_MODE_LOCAL_PROCESS
    available = True
    strong_verified = False

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def execute(
        self,
        code: str,
        stdin_text: str,
        timeout_ms: int,
        sandbox_uid: int | None = None,
        sandbox_gid: int | None = None,
        allowed_packages: tuple[str, ...] = (),
    ) -> dict[str, Any]:
        return _execute_python_local(
            self.settings,
            code,
            stdin_text,
            timeout_ms,
            sandbox_uid,
            sandbox_gid,
            allowed_packages,
        )


class StrongExternalExecutor:
    """Reserved adapter: no verified strong launcher is bundled in Slice A."""

    mode = ISOLATION_MODE_STRONG_EXTERNAL
    available = False
    strong_verified = False

    def execute(
        self,
        code: str,
        stdin_text: str,
        timeout_ms: int,
        sandbox_uid: int | None = None,
        sandbox_gid: int | None = None,
        allowed_packages: tuple[str, ...] = (),
    ) -> dict[str, Any]:
        del code, stdin_text, timeout_ms, sandbox_uid, sandbox_gid, allowed_packages
        raise RunnerNotReady("strong_external executor is not configured")


def create_executor(settings: Settings) -> LocalProcessExecutor | StrongExternalExecutor:
    """Select exactly the configured executor; never silently fall back."""
    if settings.isolation_mode == ISOLATION_MODE_LOCAL_PROCESS:
        return LocalProcessExecutor(settings)
    return StrongExternalExecutor()


RUNNER_EXECUTOR = create_executor(SETTINGS)


def runner_capabilities(
    settings: Settings | None = None,
    executor: LocalProcessExecutor | StrongExternalExecutor | None = None,
) -> dict[str, Any]:
    current_settings = settings or SETTINGS
    current_executor = executor or RUNNER_EXECUTOR
    policy = IsolationPolicy(
        mode=current_settings.isolation_mode,
        require_strong=current_settings.require_strong_isolation,
        executor_available=current_executor.available,
        strong_executor_verified=current_executor.strong_verified,
    )
    strength = "weak" if current_settings.isolation_mode == ISOLATION_MODE_LOCAL_PROCESS else "unverified"
    return {
        "status": "ok" if policy.ready else "not_ready",
        "ready": policy.ready,
        "isolation": {
            "mode": policy.mode,
            "strength": strength,
            "strong_required": policy.strong_required,
            "strong_verified": policy.strong_executor_verified,
            "executor_available": policy.executor_available,
            "fallback_used": False,
        },
        "capabilities": {
            "per_job_workspace": True,
            "workspace_cleanup": True,
            "process_tree_cleanup": True,
            "resource_limits": True,
            "ast_capability_policy": True,
            "network_policy": "ast_only",
            "egress_isolation": False,
            "strong_sandbox": policy.strong_executor_verified,
        },
    }


def _require_runner_ready() -> None:
    if not runner_capabilities()["ready"]:
        raise RunnerNotReady("runner is not ready for the configured isolation policy")


def execute_python(
    code: str,
    stdin_text: str,
    timeout_ms: int,
    sandbox_uid: int | None = None,
    sandbox_gid: int | None = None,
    allowed_packages: tuple[str, ...] = (),
) -> dict[str, Any]:
    _require_runner_ready()
    return RUNNER_EXECUTOR.execute(
        code,
        stdin_text,
        timeout_ms,
        sandbox_uid,
        sandbox_gid,
        allowed_packages,
    )


def _read_request_body(handler: BaseHTTPRequestHandler, content_length: int) -> bytes:
    """Read an exact request body within one overall deadline.

    BufferedReader.read1() performs at most one raw socket read, which lets us
    re-check the wall-clock deadline even when a client trickles bytes.
    """
    deadline = time.monotonic() + SETTINGS.request_timeout_ms / 1000
    chunks: list[bytes] = []
    remaining = content_length
    while remaining:
        seconds_left = deadline - time.monotonic()
        if seconds_left <= 0:
            raise RequestError(HTTPStatus.REQUEST_TIMEOUT, "Request body timed out")
        handler.connection.settimeout(max(0.05, seconds_left))
        try:
            read_size = min(65536, remaining)
            read1 = getattr(handler.rfile, "read1", handler.rfile.read)
            chunk = read1(read_size)
        except (socket.timeout, TimeoutError) as exc:
            raise RequestError(HTTPStatus.REQUEST_TIMEOUT, "Request body timed out") from exc
        if not chunk:
            raise RequestError(HTTPStatus.BAD_REQUEST, "Request body ended before Content-Length")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _parse_execute_request(handler: BaseHTTPRequestHandler) -> tuple[str, str, int, tuple[str, ...]]:
    content_type = handler.headers.get("Content-Type", "").split(";", 1)[0].strip()
    if content_type != "application/json":
        raise RequestError(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "Content-Type must be application/json")

    try:
        content_length = int(handler.headers.get("Content-Length", ""))
    except ValueError as exc:
        raise RequestError(HTTPStatus.LENGTH_REQUIRED, "A valid Content-Length is required") from exc
    if content_length < 1:
        raise RequestError(HTTPStatus.LENGTH_REQUIRED, "A non-empty request body is required")
    if content_length > SETTINGS.max_request_bytes:
        raise RequestError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Request body is too large")

    try:
        payload = json.loads(_read_request_body(handler, content_length))
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise RequestError(HTTPStatus.BAD_REQUEST, "Request body must be valid UTF-8 JSON") from exc
    if not isinstance(payload, dict):
        raise RequestError(HTTPStatus.BAD_REQUEST, "Request body must be a JSON object")
    if any(key not in EXECUTE_REQUEST_FIELDS for key in payload):
        raise RequestError(HTTPStatus.BAD_REQUEST, "Request contains unsupported fields")

    code = payload.get("code")
    stdin_text = payload.get("stdin", "")
    timeout_ms = payload.get("timeout_ms", SETTINGS.default_timeout_ms)
    try:
        allowed_packages = validate_allowed_packages(payload.get("allowed_packages", []))
    except CodePolicyError as exc:
        raise RequestError(HTTPStatus.UNPROCESSABLE_ENTITY, str(exc)) from exc
    if not isinstance(code, str) or not code:
        raise RequestError(HTTPStatus.BAD_REQUEST, "code must be a non-empty string")
    if not isinstance(stdin_text, str):
        raise RequestError(HTTPStatus.BAD_REQUEST, "stdin must be a string")
    if not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool):
        raise RequestError(HTTPStatus.BAD_REQUEST, "timeout_ms must be an integer")
    if len(code.encode("utf-8")) > SETTINGS.max_code_bytes:
        raise RequestError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "code is too large")
    if len(stdin_text.encode("utf-8")) > SETTINGS.max_input_bytes:
        raise RequestError(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "stdin is too large")
    if timeout_ms < 100 or timeout_ms > SETTINGS.max_timeout_ms:
        raise RequestError(
            HTTPStatus.BAD_REQUEST,
            f"timeout_ms must be between 100 and {SETTINGS.max_timeout_ms}",
        )
    try:
        validate_code_policy(code, allowed_packages)
    except CodePolicyError as exc:
        raise RequestError(HTTPStatus.UNPROCESSABLE_ENTITY, str(exc)) from exc
    return code, stdin_text, timeout_ms, allowed_packages


class RunnerHandler(BaseHTTPRequestHandler):
    server_version = "PythonLearningRunner/0.1"

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(SETTINGS.request_timeout_ms / 1000)

    def _json_response(
        self,
        status: HTTPStatus,
        payload: dict[str, Any],
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def _is_authorized(self) -> bool:
        scheme, separator, token = self.headers.get("Authorization", "").partition(" ")
        return (
            bool(separator)
            and scheme.lower() == "bearer"
            and secrets.compare_digest(token, SETTINGS.service_token)
        )

    def _drain_request_body(self) -> None:
        """Consume a bounded body before rejecting auth on Windows keep-alive."""
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.close_connection = True
            return
        if content_length <= 0:
            return
        if content_length > SETTINGS.max_request_bytes:
            self.close_connection = True
            return
        try:
            _read_request_body(self, content_length)
        except RequestError:
            self.close_connection = True

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            capabilities = runner_capabilities()
            if capabilities["ready"]:
                # Keep the existing liveness response stable for Compose and
                # older smoke clients; /ready and /capabilities expose detail.
                self._json_response(HTTPStatus.OK, {"status": "ok"})
            else:
                self._json_response(HTTPStatus.SERVICE_UNAVAILABLE, capabilities)
            return
        if self.path in {"/ready", "/capabilities"}:
            capabilities = runner_capabilities()
            status = HTTPStatus.OK
            if self.path == "/ready" and not capabilities["ready"]:
                status = HTTPStatus.SERVICE_UNAVAILABLE
            self._json_response(status, capabilities)
            return
        self._json_response(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/execute":
            self._json_response(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        if not self._is_authorized():
            self._drain_request_body()
            self._json_response(
                HTTPStatus.UNAUTHORIZED,
                {"error": "unauthorized"},
                {"WWW-Authenticate": "Bearer"},
            )
            return
        if not runner_capabilities()["ready"]:
            self._json_response(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": "runner is not ready", "code": "runner_not_ready"},
            )
            return

        try:
            code, stdin_text, timeout_ms, allowed_packages = _parse_execute_request(self)
        except RequestError as exc:
            self._json_response(exc.status, {"error": str(exc)})
            return

        try:
            execution_identity = EXECUTION_IDENTITIES.get_nowait()
        except queue.Empty:
            self._json_response(
                HTTPStatus.TOO_MANY_REQUESTS,
                {"error": "runner is busy; retry later"},
            )
            return

        try:
            self._json_response(
                HTTPStatus.OK,
                execute_python(
                    code,
                    stdin_text,
                    timeout_ms,
                    sandbox_uid=execution_identity[0],
                    sandbox_gid=execution_identity[1],
                    allowed_packages=allowed_packages,
                ),
            )
        except RequestError as exc:
            self._json_response(exc.status, {"error": str(exc)})
        except RunnerNotReady:
            self._json_response(
                HTTPStatus.SERVICE_UNAVAILABLE,
                {"error": "runner is not ready", "code": "runner_not_ready"},
            )
        except Exception as exc:
            self.log_error("execution failed: %s", exc)
            self._json_response(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "execution failed"})
        finally:
            EXECUTION_IDENTITIES.put(execution_identity)

    def log_message(self, format: str, *args: Any) -> None:
        sys.stderr.write(
            "%s - - [%s] %s\n"
            % (self.client_address[0], self.log_date_time_string(), format % args)
        )


def main() -> None:
    if SETTINGS.drop_privileges and (
        not hasattr(os, "geteuid") or os.geteuid() != 0
    ):
        raise SystemExit("RUNNER_DROP_PRIVILEGES=1 requires the service to start as root")
    if not SETTINGS.drop_privileges and not _env_bool(
        "RUNNER_ALLOW_INSECURE_NO_PRIVILEGE_DROP", False
    ):
        raise SystemExit(
            "Refusing to start without privilege dropping; this override is only for local tests"
        )
    server = ThreadingHTTPServer((SETTINGS.host, SETTINGS.port), RunnerHandler)
    print(f"runner listening on http://{SETTINGS.host}:{SETTINGS.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
