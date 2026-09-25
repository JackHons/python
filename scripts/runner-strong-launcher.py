#!/usr/bin/env python3
"""Fail-closed host launcher for disposable runsc-backed runner jobs.

The launcher deliberately has no HTTP server and does not import the runner
broker.  Its protocol is one authenticated, newline-delimited JSON request per
Unix-socket connection.  The request can carry job data only; Docker policy is
constructed entirely from this module and host-owned configuration.

The configured image must contain a fixed command that reads one JSON job from
stdin and writes one JSON result to stdout.  The image is required to be
addressed by a sha256 digest.  This module does not claim that runsc is
available on any particular host: startup verifies the Docker daemon's
registered runtimes and the local image, and refuses to serve otherwise.
"""

from __future__ import annotations

import json
import logging
import os
import re
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence


LOGGER = logging.getLogger("runner-strong-launcher")

# These labels are constants, not configuration and not request fields.  The
# reaper always requires every label in this map (plus the per-job label).
OWNER_LABEL = "com.openai.runner-strong.owner"
OWNER_LABEL_VALUE = "trusted-launcher"
MANAGED_LABEL = "com.openai.runner-strong.managed"
MANAGED_LABEL_VALUE = "true"
JOB_LABEL = "com.openai.runner-strong.job"
OWNED_LABELS = {
    OWNER_LABEL: OWNER_LABEL_VALUE,
    MANAGED_LABEL: MANAGED_LABEL_VALUE,
}

DEFAULT_CONTAINER_COMMAND = ("/opt/runner/strong-job",)
DEFAULT_MEMORY_LIMIT = "512m"
DEFAULT_CPU_LIMIT = "1.0"
DEFAULT_PIDS_LIMIT = 64
DEFAULT_TMPFS = "/tmp:rw,noexec,nosuid,nodev,size=64m"
DEFAULT_UID = 10001
DEFAULT_GID = 10001
DEFAULT_MAX_REQUEST_BYTES = 196608
DEFAULT_MAX_RESPONSE_BYTES = 262144
DEFAULT_MAX_CODE_BYTES = 102400
DEFAULT_MAX_STDIN_BYTES = 65536
DEFAULT_MIN_TIMEOUT_MS = 100
DEFAULT_MAX_TIMEOUT_MS = 5000
DEFAULT_DEFAULT_TIMEOUT_MS = 3000
DEFAULT_SOCKET_TIMEOUT_MS = 6000
DEFAULT_CLEANUP_TIMEOUT_MS = 1500
MAX_CONFIG_REQUEST_BYTES = 1024 * 1024
MAX_CONFIG_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_CONTAINER_COMMAND_ITEMS = 16
MAX_CONTAINER_COMMAND_ITEM_BYTES = 256
MAX_CONTAINER_ID_BYTES = 64

REQUEST_FIELDS = frozenset({"token", "code", "stdin", "timeout_ms"})
SUPPORTED_PACKAGES = frozenset({"numpy", "pandas", "matplotlib"})
CHILD_RESPONSE_FIELDS = frozenset(
    {"stdout", "stderr", "exit_code", "timed_out", "output_limited", "duration_ms"}
)
IMAGE_DIGEST_RE = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[0-9a-f]{64}$"
)
JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")
CONTAINER_ID_RE = re.compile(r"^[0-9a-fA-F]{12,64}$")


class LauncherError(Exception):
    """An expected, safe-to-report launcher failure."""


class ConfigurationError(LauncherError):
    pass


class CapabilityError(LauncherError):
    pass


class RequestValidationError(LauncherError):
    pass


class ChildResponseError(LauncherError):
    pass


@dataclass(frozen=True)
class LauncherConfig:
    socket_path: Path
    token_file: Path
    image: str
    docker_bin: str = "docker"
    container_command: tuple[str, ...] = DEFAULT_CONTAINER_COMMAND
    memory_limit: str = DEFAULT_MEMORY_LIMIT
    cpu_limit: str = DEFAULT_CPU_LIMIT
    pids_limit: int = DEFAULT_PIDS_LIMIT
    tmpfs_spec: str = DEFAULT_TMPFS
    uid: int = DEFAULT_UID
    gid: int = DEFAULT_GID
    max_request_bytes: int = DEFAULT_MAX_REQUEST_BYTES
    max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES
    max_code_bytes: int = DEFAULT_MAX_CODE_BYTES
    max_stdin_bytes: int = DEFAULT_MAX_STDIN_BYTES
    min_timeout_ms: int = DEFAULT_MIN_TIMEOUT_MS
    max_timeout_ms: int = DEFAULT_MAX_TIMEOUT_MS
    default_timeout_ms: int = DEFAULT_DEFAULT_TIMEOUT_MS
    socket_timeout_ms: int = DEFAULT_SOCKET_TIMEOUT_MS
    cleanup_timeout_ms: int = DEFAULT_CLEANUP_TIMEOUT_MS

    @classmethod
    def from_env(cls) -> "LauncherConfig":
        socket_path = _absolute_path_env(
            "RUNNER_STRONG_SOCKET", "/run/runner-strong/launcher.sock"
        )
        token_file = _absolute_path_env("RUNNER_STRONG_TOKEN_FILE", "")
        image = os.environ.get("RUNNER_STRONG_IMAGE", "").strip()
        if not token_file:
            raise ConfigurationError("required launcher configuration is missing")
        if not IMAGE_DIGEST_RE.fullmatch(image):
            raise ConfigurationError("configured image must use a sha256 digest")

        docker_bin = os.environ.get("RUNNER_STRONG_DOCKER", "docker").strip()
        if not docker_bin or "\x00" in docker_bin:
            raise ConfigurationError("docker executable configuration is invalid")

        command_raw = os.environ.get("RUNNER_STRONG_CONTAINER_COMMAND", "")
        command = DEFAULT_CONTAINER_COMMAND
        if command_raw:
            try:
                decoded = json.loads(command_raw)
            except (TypeError, ValueError) as exc:
                raise ConfigurationError("container command configuration is invalid") from exc
            command = _validate_container_command(decoded)

        max_timeout_ms = _bounded_int_env(
            "RUNNER_STRONG_MAX_TIMEOUT_MS",
            DEFAULT_MAX_TIMEOUT_MS,
            DEFAULT_MIN_TIMEOUT_MS,
            60_000,
        )
        min_timeout_ms = _bounded_int_env(
            "RUNNER_STRONG_MIN_TIMEOUT_MS",
            DEFAULT_MIN_TIMEOUT_MS,
            1,
            max_timeout_ms,
        )
        default_timeout_ms = _bounded_int_env(
            "RUNNER_STRONG_DEFAULT_TIMEOUT_MS",
            DEFAULT_DEFAULT_TIMEOUT_MS,
            min_timeout_ms,
            max_timeout_ms,
        )
        return cls(
            socket_path=socket_path,
            token_file=Path(token_file),
            image=image,
            docker_bin=docker_bin,
            container_command=command,
            max_request_bytes=_bounded_int_env(
                "RUNNER_STRONG_MAX_REQUEST_BYTES",
                DEFAULT_MAX_REQUEST_BYTES,
                1024,
                MAX_CONFIG_REQUEST_BYTES,
            ),
            max_response_bytes=_bounded_int_env(
                "RUNNER_STRONG_MAX_RESPONSE_BYTES",
                DEFAULT_MAX_RESPONSE_BYTES,
                1024,
                MAX_CONFIG_RESPONSE_BYTES,
            ),
            max_code_bytes=_bounded_int_env(
                "RUNNER_STRONG_MAX_CODE_BYTES",
                DEFAULT_MAX_CODE_BYTES,
                1,
                DEFAULT_MAX_CODE_BYTES,
            ),
            max_stdin_bytes=_bounded_int_env(
                "RUNNER_STRONG_MAX_STDIN_BYTES",
                DEFAULT_MAX_STDIN_BYTES,
                0,
                DEFAULT_MAX_STDIN_BYTES,
            ),
            min_timeout_ms=min_timeout_ms,
            max_timeout_ms=max_timeout_ms,
            default_timeout_ms=default_timeout_ms,
            socket_timeout_ms=_bounded_int_env(
                "RUNNER_STRONG_SOCKET_TIMEOUT_MS",
                DEFAULT_SOCKET_TIMEOUT_MS,
                500,
                60_000,
            ),
            cleanup_timeout_ms=_bounded_int_env(
                "RUNNER_STRONG_CLEANUP_TIMEOUT_MS",
                DEFAULT_CLEANUP_TIMEOUT_MS,
                100,
                10_000,
            ),
        )

    def validate(self) -> None:
        if os.name != "posix" or not hasattr(socket, "AF_UNIX"):
            raise ConfigurationError("Unix sockets are required")
        if not self.socket_path.is_absolute() or len(str(self.socket_path).encode()) >= 104:
            raise ConfigurationError("Unix socket path is invalid")
        if not IMAGE_DIGEST_RE.fullmatch(self.image):
            raise ConfigurationError("configured image must use a sha256 digest")
        _validate_container_command(self.container_command)
        if self.uid <= 0 or self.gid <= 0:
            raise ConfigurationError("container identity must be non-root")
        if self.pids_limit < 1 or self.pids_limit > 4096:
            raise ConfigurationError("process limit is invalid")
        if not self.memory_limit or not self.cpu_limit or not self.tmpfs_spec:
            raise ConfigurationError("resource limits are required")
        if self.max_request_bytes < 1024 or self.max_request_bytes > MAX_CONFIG_REQUEST_BYTES:
            raise ConfigurationError("request bound is invalid")
        if self.max_response_bytes < 1024 or self.max_response_bytes > MAX_CONFIG_RESPONSE_BYTES:
            raise ConfigurationError("response bound is invalid")
        if not self.min_timeout_ms <= self.default_timeout_ms <= self.max_timeout_ms:
            raise ConfigurationError("timeout bounds are invalid")


def _absolute_path_env(name: str, default: str) -> Path | str:
    value = os.environ.get(name, default).strip()
    if not value:
        return ""
    path = Path(value)
    if not path.is_absolute() or "\x00" in value:
        raise ConfigurationError("path configuration is invalid")
    return path


def _bounded_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name, str(default))
    try:
        value = int(raw, 10)
    except (TypeError, ValueError) as exc:
        raise ConfigurationError("numeric configuration is invalid") from exc
    if value < minimum or value > maximum:
        raise ConfigurationError("numeric configuration is outside its safe bound")
    return value


def _validate_container_command(value: Any) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)) or not value or len(value) > MAX_CONTAINER_COMMAND_ITEMS:
        raise ConfigurationError("container command must be a bounded non-empty argv")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item or "\x00" in item:
            raise ConfigurationError("container command contains an invalid argument")
        if len(item.encode("utf-8")) > MAX_CONTAINER_COMMAND_ITEM_BYTES:
            raise ConfigurationError("container command argument is too long")
        result.append(item)
    return tuple(result)


def _safe_token_file(path: Path) -> str:
    try:
        info = path.stat()
    except OSError as exc:
        raise ConfigurationError("authentication token file is unavailable") from exc
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise ConfigurationError("authentication token file permissions are unsafe")
    if hasattr(os, "geteuid") and info.st_uid not in (0, os.geteuid()):
        raise ConfigurationError("authentication token file owner is unsafe")
    try:
        raw = path.read_bytes()
    except OSError as exc:
        raise ConfigurationError("authentication token file is unavailable") from exc
    if len(raw) < 24 or len(raw) > 256 or b"\n" in raw or b"\r" in raw:
        raise ConfigurationError("authentication token file is invalid")
    try:
        token = raw.decode("ascii")
    except UnicodeDecodeError as exc:
        raise ConfigurationError("authentication token file is invalid") from exc
    if not token or any(character.isspace() for character in token):
        raise ConfigurationError("authentication token file is invalid")
    return token


def _result_bytes(result: Any, field: str) -> bytes:
    value = getattr(result, field, b"")
    if isinstance(value, bytes):
        return value
    if isinstance(value, str):
        return value.encode("utf-8", errors="replace")
    return b""


def _result_code(result: Any) -> int:
    value = getattr(result, "returncode", None)
    return value if isinstance(value, int) else 1


def _default_command_runner(argv: Sequence[str], timeout_seconds: float) -> Any:
    return subprocess.run(
        list(argv),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        shell=False,
        timeout=timeout_seconds,
        check=False,
    )


def _docker_label_filters(job_id: str | None = None) -> list[str]:
    filters = [
        f"--filter=label={OWNER_LABEL}={OWNER_LABEL_VALUE}",
        f"--filter=label={MANAGED_LABEL}={MANAGED_LABEL_VALUE}",
    ]
    if job_id is not None:
        if not JOB_ID_RE.fullmatch(job_id):
            raise ValueError("invalid job id")
        filters.append(f"--filter=label={JOB_LABEL}={job_id}")
    return filters


def build_docker_argv(config: LauncherConfig, job_id: str) -> list[str]:
    """Build the only Docker argv accepted by this launcher."""
    if not JOB_ID_RE.fullmatch(job_id):
        raise ValueError("invalid job id")
    # Unix-socket and host ownership checks belong to startup_check().  Keep
    # argv construction independently testable on non-Unix development hosts.
    if not IMAGE_DIGEST_RE.fullmatch(config.image):
        raise ConfigurationError("configured image must use a sha256 digest")
    _validate_container_command(config.container_command)
    if config.uid <= 0 or config.gid <= 0:
        raise ConfigurationError("container identity must be non-root")
    if config.pids_limit < 1 or config.pids_limit > 4096:
        raise ConfigurationError("process limit is invalid")
    labels = [
        f"--label={OWNER_LABEL}={OWNER_LABEL_VALUE}",
        f"--label={MANAGED_LABEL}={MANAGED_LABEL_VALUE}",
        f"--label={JOB_LABEL}={job_id}",
    ]
    return [
        config.docker_bin,
        "run",
        "--rm",
        "-i",
        "--runtime=runsc",
        "--pull=never",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true",
        f"--pids-limit={config.pids_limit}",
        f"--memory={config.memory_limit}",
        f"--cpus={config.cpu_limit}",
        f"--tmpfs={config.tmpfs_spec}",
        f"--user={config.uid}:{config.gid}",
        f"--name=runner-strong-{job_id}",
        *labels,
        config.image,
        *config.container_command,
    ]


def _owned_container_ids(output: bytes) -> list[str]:
    ids: list[str] = []
    for candidate in output.decode("ascii", errors="ignore").split():
        if CONTAINER_ID_RE.fullmatch(candidate) and candidate not in ids:
            ids.append(candidate)
    return ids


class Launcher:
    """The policy-owning launcher, with injectable process calls for tests."""

    def __init__(
        self,
        config: LauncherConfig,
        *,
        token: str | None = None,
        command_runner: Callable[[Sequence[str], float], Any] = _default_command_runner,
        process_factory: Callable[..., Any] = subprocess.Popen,
        which: Callable[[str], str | None] = shutil.which,
    ) -> None:
        self.config = config
        self._token = token
        self._command_runner = command_runner
        self._process_factory = process_factory
        self._which = which

    def startup_check(self) -> None:
        """Refuse service startup unless every required host capability is ready."""
        self.config.validate()
        if self._which(self.config.docker_bin) is None and not Path(self.config.docker_bin).is_absolute():
            raise CapabilityError("docker executable is unavailable")
        self._token = _safe_token_file(self.config.token_file)
        self._check_docker_capabilities()
        if not self.reap_owned_containers():
            raise CapabilityError("owned-container cleanup is unavailable")

    def _run_command(self, argv: Sequence[str]) -> Any:
        try:
            return self._command_runner(argv, self.config.cleanup_timeout_ms / 1000)
        except (OSError, subprocess.SubprocessError, TimeoutError):
            return None

    def _check_docker_capabilities(self) -> None:
        info = self._run_command(
            [self.config.docker_bin, "info", "--format", "{{json .Runtimes}}"]
        )
        if info is None or _result_code(info) != 0:
            raise CapabilityError("docker daemon is unavailable")
        try:
            runtimes = json.loads(_result_bytes(info, "stdout").decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise CapabilityError("docker runtime capability is unavailable")
        if not isinstance(runtimes, dict) or "runsc" not in runtimes:
            raise CapabilityError("runsc runtime is unavailable")

        image = self._run_command(
            [
                self.config.docker_bin,
                "image",
                "inspect",
                "--format",
                "{{.Id}}",
                self.config.image,
            ]
        )
        if image is None or _result_code(image) != 0 or not _result_bytes(image, "stdout").strip():
            raise CapabilityError("configured image is unavailable")

    def reap_owned_containers(self, job_id: str | None = None) -> bool:
        """Remove only containers carrying all exact launcher ownership labels."""
        try:
            argv = [
                self.config.docker_bin,
                "ps",
                "--all",
                "--quiet",
                *_docker_label_filters(job_id),
            ]
        except ValueError:
            return False
        listed = self._run_command(argv)
        if listed is None or _result_code(listed) != 0:
            return False
        container_ids = _owned_container_ids(_result_bytes(listed, "stdout"))
        if not container_ids:
            return True
        # IDs came from an exact owner+managed+(optional job) label query and
        # are syntactically constrained before they reach docker rm.
        for offset in range(0, len(container_ids), 32):
            removed = self._run_command(
                [self.config.docker_bin, "rm", "--force", *container_ids[offset : offset + 32]]
            )
            if removed is None or _result_code(removed) != 0:
                return False
        return True

    def capabilities(self) -> dict[str, Any]:
        """Return the fixed capability contract after startup checks pass."""
        return {
            "ok": True,
            "capabilities": {
                "protocol": "runner-strong-executor",
                "version": 1,
                "ready": True,
                "runtime": "runsc",
                "disposable": True,
                "network": "none",
                "readOnlyRoot": True,
                "nonRoot": self.config.uid > 0 and self.config.gid > 0,
                "resourceLimits": bool(
                    self.config.memory_limit
                    and self.config.cpu_limit
                    and self.config.pids_limit
                    and self.config.tmpfs_spec
                ),
                "imagePinned": "@sha256:" in self.config.image,
            },
        }

    def handle_request(self, payload: Any) -> dict[str, Any]:
        """Authenticate and execute one already-decoded protocol request."""
        if not isinstance(payload, dict) or isinstance(payload, list):
            return _error_response("invalid_request")
        supplied_token = payload.get("token")
        if not isinstance(supplied_token, str) or not self._token or not secrets.compare_digest(
            supplied_token, self._token
        ):
            return _error_response("unauthorized")
        if payload.get("op") == "capabilities":
            if set(payload) != {"op", "token"}:
                return _error_response("invalid_request")
            return self.capabilities()
        if set(payload) - (REQUEST_FIELDS | {"allowed_packages"}) or "code" not in payload:
            return _error_response("invalid_request")
        try:
            code = payload["code"]
            stdin_text = payload.get("stdin", "")
            timeout_ms = payload.get("timeout_ms", self.config.default_timeout_ms)
            allowed_packages = payload.get("allowed_packages", [])
            if not isinstance(code, str) or not code:
                raise RequestValidationError("code is invalid")
            if not isinstance(stdin_text, str):
                raise RequestValidationError("stdin is invalid")
            if not isinstance(allowed_packages, list) or any(
                not isinstance(package, str) or package not in SUPPORTED_PACKAGES
                for package in allowed_packages
            ):
                raise RequestValidationError("allowed packages are invalid")
            if len(code.encode("utf-8")) > self.config.max_code_bytes:
                raise RequestValidationError("code is too large")
            if len(stdin_text.encode("utf-8")) > self.config.max_stdin_bytes:
                raise RequestValidationError("stdin is too large")
            if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int):
                raise RequestValidationError("timeout is invalid")
            if not self.config.min_timeout_ms <= timeout_ms <= self.config.max_timeout_ms:
                raise RequestValidationError("timeout is outside the safe bound")
        except (UnicodeEncodeError, RequestValidationError):
            return _error_response("invalid_request")

        try:
            return self.execute_job(code, stdin_text, timeout_ms, allowed_packages)
        except LauncherError as exc:
            LOGGER.warning("runner request failed: %s", _safe_error_code(exc))
            return _error_response(_safe_error_code(exc))
        except Exception:
            # Do not put host paths, Docker stderr, image names, or job input in
            # the protocol response or logs.
            LOGGER.exception("runner request failed")
            return _error_response("runner_failed")

    def execute_job(
        self, code: str, stdin_text: str, timeout_ms: int, allowed_packages: list[str]
    ) -> dict[str, Any]:
        job_id = uuid.uuid4().hex
        child_input = json.dumps(
            {
                "code": code,
                "stdin": stdin_text,
                "timeout_ms": timeout_ms,
                "allowed_packages": allowed_packages,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8") + b"\n"
        argv = build_docker_argv(self.config, job_id)
        timed_out = False
        overflowed = False
        try:
            try:
                process = self._process_factory(
                    argv,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    shell=False,
                    close_fds=True,
                    **_process_group_options(),
                )
            except (OSError, subprocess.SubprocessError) as exc:
                raise LauncherError("runner_failed") from exc
            stdout, stderr, timed_out, overflowed = _communicate_bounded(
                process,
                child_input,
                self.config.max_response_bytes,
                self.config.cleanup_timeout_ms,
                timeout_ms,
            )
            if timed_out:
                raise LauncherError("runner_timeout")
            if overflowed:
                raise LauncherError("response_too_large")
            if getattr(process, "returncode", 1) != 0:
                raise LauncherError("runner_failed")
            del stderr  # Docker diagnostics are never returned to the client.
            return _parse_child_response(stdout, self.config.max_response_bytes)
        finally:
            # --rm is still present, but explicit scoped cleanup is required
            # after a timeout or daemon/client failure.
            if not self.reap_owned_containers(job_id):
                LOGGER.warning("owned container cleanup was incomplete")


def _safe_error_code(error: LauncherError) -> str:
    allowed = {
        "runner_failed",
        "runner_timeout",
        "response_too_large",
        "response_invalid",
        "runner_unavailable",
    }
    return str(error) if str(error) in allowed else "runner_failed"


def _error_response(code: str) -> dict[str, Any]:
    return {"ok": False, "error": code}


def _process_group_options() -> dict[str, Any]:
    if os.name == "posix":
        return {"start_new_session": True}
    creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    return {"creationflags": creationflags} if creationflags else {}


def _terminate_process(process: Any) -> None:
    pid = getattr(process, "pid", None)
    if os.name == "posix" and isinstance(pid, int):
        try:
            os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
    try:
        if process.poll() is None:
            process.kill()
    except (AttributeError, ProcessLookupError, PermissionError, OSError):
        pass


def _communicate_bounded(
    process: Any,
    input_bytes: bytes,
    max_bytes: int,
    cleanup_timeout_ms: int,
    timeout_ms: int,
) -> tuple[bytes, bytes, bool, bool]:
    """Pipe input and collect both streams without allowing unbounded output."""
    outputs: dict[str, bytearray] = {"stdout": bytearray(), "stderr": bytearray()}
    output_lock = threading.Lock()
    output_overflow = threading.Event()
    writer_error = threading.Event()

    def drain(name: str, stream: Any) -> None:
        try:
            while not output_overflow.is_set():
                chunk = stream.read(8192)
                if not chunk:
                    return
                if isinstance(chunk, str):
                    chunk = chunk.encode("utf-8", errors="replace")
                with output_lock:
                    available = max_bytes - len(outputs[name])
                    if len(chunk) > available:
                        if available > 0:
                            outputs[name].extend(chunk[:available])
                        output_overflow.set()
                        return
                    outputs[name].extend(chunk)
        except (OSError, ValueError, AttributeError):
            return

    def write_input() -> None:
        try:
            if process.stdin is not None:
                process.stdin.write(input_bytes)
                process.stdin.close()
        except (OSError, ValueError, AttributeError):
            writer_error.set()

    readers = [
        threading.Thread(target=drain, args=("stdout", process.stdout), daemon=True),
        threading.Thread(target=drain, args=("stderr", process.stderr), daemon=True),
    ]
    for reader in readers:
        reader.start()
    writer = threading.Thread(target=write_input, daemon=True)
    writer.start()

    timed_out = False
    deadline = time.monotonic() + timeout_ms / 1000
    while True:
        if output_overflow.is_set():
            _terminate_process(process)
            break
        if process.poll() is not None:
            break
        if time.monotonic() >= deadline:
            timed_out = True
            _terminate_process(process)
            break
        time.sleep(0.005)

    try:
        process.wait(timeout=max(0.1, cleanup_timeout_ms / 1000))
    except (subprocess.TimeoutExpired, OSError):
        _terminate_process(process)
        try:
            process.wait(timeout=1)
        except (subprocess.TimeoutExpired, OSError):
            pass
    writer.join(timeout=1)
    for reader in readers:
        reader.join(timeout=1)
    if writer_error.is_set() and not timed_out and not output_overflow.is_set():
        _terminate_process(process)
    return bytes(outputs["stdout"]), bytes(outputs["stderr"]), timed_out, output_overflow.is_set()


def _parse_child_response(raw: bytes, max_bytes: int) -> dict[str, Any]:
    if len(raw) > max_bytes:
        raise LauncherError("response_too_large")
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise LauncherError("response_invalid")
    if not isinstance(payload, dict) or set(payload) - CHILD_RESPONSE_FIELDS:
        raise LauncherError("response_invalid")
    required = {"stdout", "stderr", "exit_code", "timed_out", "output_limited"}
    if not required.issubset(payload):
        raise LauncherError("response_invalid")
    if not isinstance(payload["stdout"], str) or not isinstance(payload["stderr"], str):
        raise LauncherError("response_invalid")
    if not isinstance(payload["exit_code"], int) or isinstance(payload["exit_code"], bool):
        raise LauncherError("response_invalid")
    if not isinstance(payload["timed_out"], bool) or not isinstance(payload["output_limited"], bool):
        raise LauncherError("response_invalid")
    if "duration_ms" in payload and (
        not isinstance(payload["duration_ms"], int)
        or isinstance(payload["duration_ms"], bool)
        or payload["duration_ms"] < 0
    ):
        raise LauncherError("response_invalid")
    if len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) > max_bytes:
        raise LauncherError("response_too_large")
    return {"ok": True, **payload}


def _read_request(connection: socket.socket, max_bytes: int, timeout_ms: int) -> bytes:
    connection.settimeout(timeout_ms / 1000)
    data = bytearray()
    while b"\n" not in data:
        chunk = connection.recv(min(8192, max_bytes + 1 - len(data)))
        if not chunk:
            break
        data.extend(chunk)
        if len(data) > max_bytes:
            raise RequestValidationError("request is too large")
    if b"\n" in data:
        line, remainder = bytes(data).split(b"\n", 1)
        if remainder.strip():
            raise RequestValidationError("request contains multiple messages")
        return line
    return bytes(data)


def _encode_protocol_response(payload: Mapping[str, Any], max_bytes: int) -> bytes:
    try:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError):
        encoded = b'{"ok":false,"error":"runner_failed"}'
    if len(encoded) > max_bytes:
        encoded = b'{"ok":false,"error":"response_too_large"}'
    return encoded + b"\n"


def _decode_request(raw: bytes) -> Any:
    if not raw:
        raise RequestValidationError("empty request")
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise RequestValidationError("invalid JSON") from exc


def serve(launcher: Launcher) -> None:
    config = launcher.config
    config.validate()
    parent = config.socket_path.parent
    try:
        parent_info = parent.stat()
    except OSError as exc:
        raise ConfigurationError("socket directory is unavailable") from exc
    if not stat.S_ISDIR(parent_info.st_mode) or parent_info.st_mode & 0o002:
        raise ConfigurationError("socket directory ownership is unsafe")
    if hasattr(os, "geteuid") and parent_info.st_uid not in (0, os.geteuid()):
        raise ConfigurationError("socket directory owner is unsafe")

    if config.socket_path.exists() or config.socket_path.is_symlink():
        try:
            existing = config.socket_path.lstat()
        except OSError as exc:
            raise ConfigurationError("socket path is unavailable") from exc
        if not stat.S_ISSOCK(existing.st_mode):
            raise ConfigurationError("socket path is not a socket")
        if hasattr(os, "geteuid") and existing.st_uid not in (0, os.geteuid()):
            raise ConfigurationError("socket path owner is unsafe")
        try:
            config.socket_path.unlink()
        except OSError as exc:
            raise ConfigurationError("socket path cannot be replaced") from exc

    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        listener.bind(str(config.socket_path))
        os.chmod(config.socket_path, 0o660)
        listener.listen(8)
        while True:
            connection, _ = listener.accept()
            with connection:
                try:
                    payload = _decode_request(
                        _read_request(connection, config.max_request_bytes, config.socket_timeout_ms)
                    )
                    response = launcher.handle_request(payload)
                except RequestValidationError as exc:
                    response = _error_response(
                        "request_too_large" if "too large" in str(exc) else "invalid_request"
                    )
                except (socket.timeout, OSError):
                    response = _error_response("invalid_request")
                connection.sendall(_encode_protocol_response(response, config.max_response_bytes))
    finally:
        listener.close()
        try:
            if config.socket_path.exists() and config.socket_path.is_socket():
                config.socket_path.unlink()
        except OSError:
            pass


def main() -> int:
    try:
        config = LauncherConfig.from_env()
        launcher = Launcher(config)
        launcher.startup_check()
        serve(launcher)
    except KeyboardInterrupt:
        return 0
    except LauncherError:
        print("runner strong launcher unavailable", file=sys.stderr)
        return 78
    except Exception:
        print("runner strong launcher unavailable", file=sys.stderr)
        return 78
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
