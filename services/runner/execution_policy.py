"""Shared request and source policy for the bounded Python job worker.

This module intentionally contains no HTTP, authentication, database, or
broker integration.  Its limits and source checks mirror the existing
``services/runner/server.py`` local-process contract so a one-shot job has the
same application-visible behavior without importing the long-running server.
"""

from __future__ import annotations

import ast
import importlib.util
import sys
import sysconfig
from dataclasses import dataclass
from pathlib import Path
from typing import Any


MAX_REQUEST_BYTES = 196_608
MAX_CODE_BYTES = 102_400
MAX_INPUT_BYTES = 65_536
MAX_OUTPUT_BYTES = 65_536
MAX_TIMEOUT_MS = 5_000
DEFAULT_TIMEOUT_MS = 3_000
MIN_TIMEOUT_MS = 100
MEMORY_BYTES = 768 * 1024 * 1024
MAX_FILE_BYTES = 5 * 1024 * 1024
CHILD_PROCESS_COUNT = 128

SUPPORTED_PACKAGES = frozenset({"numpy", "pandas", "matplotlib"})

FORBIDDEN_IMPORTS = frozenset(
    {
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
)
FORBIDDEN_CALLS = frozenset(
    {
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
)
REQUEST_FIELDS = frozenset({"code", "stdin", "timeout_ms", "allowed_packages"})


class PolicyError(ValueError):
    """A request or source program violates the runner policy."""


@dataclass(frozen=True)
class JobRequest:
    code: str
    stdin: str
    timeout_ms: int
    allowed_packages: tuple[str, ...]


def _path_is_within(path: Path, root: Path) -> bool:
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
    return any(part.casefold() in {"site-packages", "dist-packages"} for part in path.parts)


def is_stdlib_module(name: str) -> bool:
    """Return true only for modules supplied by this Python installation."""
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
    candidates: list[Path] = []
    if spec.origin:
        candidates.append(Path(spec.origin).resolve())
    if spec.submodule_search_locations:
        candidates.extend(Path(value).resolve() for value in spec.submodule_search_locations)
    return bool(candidates) and all(
        not _has_third_party_path_component(candidate)
        and any(_path_is_within(candidate, root) for root in STDLIB_PATHS)
        and not any(_path_is_within(candidate, root) for root in THIRD_PARTY_PATHS)
        for candidate in candidates
    )


def validate_allowed_packages(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list) or any(
        not isinstance(item, str) or item not in SUPPORTED_PACKAGES for item in value
    ):
        raise PolicyError("allowed_packages contains an unsupported package")
    return tuple(dict.fromkeys(value))


def validate_code_policy(code: str, allowed_packages: tuple[str, ...] = ()) -> None:
    """Apply the same AST capability policy as the current HTTP runner."""
    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError:
        # The child interpreter reports syntax errors as ordinary execution
        # failures, matching server.py rather than treating them as policy
        # violations.
        return
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names = [alias.name.split(".", 1)[0] for alias in node.names]
            if any(name in FORBIDDEN_IMPORTS for name in names):
                raise PolicyError("code uses a blocked capability")
            if any(
                not is_stdlib_module(name) and name not in allowed_packages for name in names
            ):
                raise PolicyError("code imports a package that is not enabled for this course")
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".", 1)[0]
            if root in FORBIDDEN_IMPORTS:
                raise PolicyError("code uses a blocked capability")
            if root and not is_stdlib_module(root) and root not in allowed_packages:
                raise PolicyError("code imports a package that is not enabled for this course")
        elif isinstance(node, ast.Call):
            function_name = (
                node.func.id
                if isinstance(node.func, ast.Name)
                else node.func.attr
                if isinstance(node.func, ast.Attribute)
                else ""
            )
            if function_name in FORBIDDEN_CALLS:
                raise PolicyError("code uses a blocked capability")


def validate_job_request(payload: Any) -> JobRequest:
    """Validate one JSON job using the HTTP runner's request semantics."""
    if not isinstance(payload, dict):
        raise PolicyError("Request body must be a JSON object")
    if any(key not in REQUEST_FIELDS for key in payload):
        raise PolicyError("Request contains unsupported fields")

    code = payload.get("code")
    stdin_text = payload.get("stdin", "")
    timeout_ms = payload.get("timeout_ms", DEFAULT_TIMEOUT_MS)
    allowed_packages = validate_allowed_packages(payload.get("allowed_packages", []))

    if not isinstance(code, str) or not code:
        raise PolicyError("code must be a non-empty string")
    if not isinstance(stdin_text, str):
        raise PolicyError("stdin must be a string")
    if not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool):
        raise PolicyError("timeout_ms must be an integer")
    if len(code.encode("utf-8")) > MAX_CODE_BYTES:
        raise PolicyError("code is too large")
    if len(stdin_text.encode("utf-8")) > MAX_INPUT_BYTES:
        raise PolicyError("stdin is too large")
    if timeout_ms < MIN_TIMEOUT_MS or timeout_ms > MAX_TIMEOUT_MS:
        raise PolicyError(f"timeout_ms must be between {MIN_TIMEOUT_MS} and {MAX_TIMEOUT_MS}")
    validate_code_policy(code, allowed_packages)
    return JobRequest(code, stdin_text, timeout_ms, allowed_packages)
