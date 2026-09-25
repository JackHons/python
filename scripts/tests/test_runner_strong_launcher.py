from __future__ import annotations

import importlib.util
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "runner-strong-launcher.py"
SPEC = importlib.util.spec_from_file_location("runner_strong_launcher", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
launcher = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = launcher
SPEC.loader.exec_module(launcher)


IMAGE = "registry.example.test/runner@sha256:" + "a" * 64


def config(tmp: Path) -> launcher.LauncherConfig:
    return launcher.LauncherConfig(
        socket_path=tmp / "launcher.sock",
        token_file=tmp / "token",
        image=IMAGE,
        docker_bin="docker",
        container_command=("/opt/runner/strong-job",),
    )


class FakeProcess:
    def __init__(self, stdout: bytes, stderr: bytes = b"", returncode: int = 0) -> None:
        self.stdin = self._Input()
        self.stdout = self._Stream(stdout)
        self.stderr = self._Stream(stderr)
        self.returncode = returncode
        self.pid = None
        self.killed = False
        self.input_bytes = b""

    class _Input:
        def __init__(self) -> None:
            self.owner: FakeProcess | None = None

        def write(self, data: bytes) -> None:
            if self.owner is not None:
                self.owner.input_bytes += data

        def close(self) -> None:
            return None

    class _Stream:
        def __init__(self, data: bytes) -> None:
            self.data = data

        def read(self, _size: int) -> bytes:
            data, self.data = self.data, b""
            return data

    def poll(self) -> int:
        return self.returncode

    def wait(self, timeout: float | None = None) -> int:
        del timeout
        return self.returncode

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9


class RecordingProcessFactory:
    def __init__(self, child_response: dict[str, object]) -> None:
        self.argv: list[str] | None = None
        self.kwargs: dict[str, object] | None = None
        self.process = FakeProcess(json.dumps(child_response).encode() + b"\n")
        self.process.stdin.owner = self.process

    def __call__(self, argv: list[str], **kwargs: object) -> FakeProcess:
        self.argv = argv
        self.kwargs = kwargs
        return self.process


class RecordingCommandRunner:
    def __init__(self, *, runtime: bool = True, image: bool = True) -> None:
        self.calls: list[list[str]] = []
        self.runtime = runtime
        self.image = image

    def __call__(self, argv: list[str], timeout: float) -> SimpleNamespace:
        del timeout
        self.calls.append(list(argv))
        if argv[1:3] == ["info", "--format"]:
            return SimpleNamespace(
                returncode=0 if self.runtime else 1,
                stdout=b'{"runc":{},"runsc":{}}' if self.runtime else b"{}",
                stderr=b"",
            )
        if argv[1:4] == ["image", "inspect", "--format"]:
            return SimpleNamespace(
                returncode=0 if self.image else 1,
                stdout=b"sha256:local-image-id\n" if self.image else b"",
                stderr=b"",
            )
        if argv[1:4] == ["ps", "--all", "--quiet"]:
            return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")
        if argv[1:3] == ["rm", "--force"]:
            return SimpleNamespace(returncode=0, stdout=b"", stderr=b"")
        raise AssertionError(f"unexpected command: {argv!r}")


class LauncherTests(unittest.TestCase):
    def test_capability_handshake_returns_fixed_strong_contract(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            runner = launcher.Launcher(
                config(Path(raw)),
                token="t" * 24,
                which=lambda _value: "docker.exe",
            )
            runner._ready = True
            self.assertEqual(
                runner.handle_request({"op": "capabilities", "token": "t" * 24}),
                {
                    "ok": True,
                    "capabilities": {
                        "protocol": "runner-strong-executor",
                        "version": 1,
                        "ready": True,
                        "runtime": "runsc",
                        "disposable": True,
                        "network": "none",
                        "readOnlyRoot": True,
                        "nonRoot": True,
                        "resourceLimits": True,
                        "imagePinned": True,
                    },
                },
            )

    def test_docker_argv_is_fixed_and_non_root(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            cfg = config(Path(raw))
            argv = launcher.build_docker_argv(cfg, "b" * 32)
        joined = "\0".join(argv)
        for required in (
            "-i",
            "--runtime=runsc",
            "--pull=never",
            "--network=none",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges:true",
            "--pids-limit=64",
            "--memory=512m",
            "--cpus=1.0",
            "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=64m",
            "--user=10001:10001",
            "--label=com.openai.runner-strong.owner=trusted-launcher",
            "--label=com.openai.runner-strong.managed=true",
        ):
            self.assertIn(required, argv)
        self.assertIn("--pull=never", argv)
        self.assertIn(IMAGE, argv)
        self.assertTrue(joined.endswith("\0/opt/runner/strong-job"))
        self.assertNotIn("--privileged", argv)
        self.assertNotIn("--network=host", argv)

    def test_request_fields_cannot_override_docker_policy(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            cfg = config(Path(raw))
            commands = RecordingCommandRunner()
            factory = RecordingProcessFactory(
                {
                    "stdout": "ok\n",
                    "stderr": "",
                    "exit_code": 0,
                    "timed_out": False,
                    "output_limited": False,
                }
            )
            runner = launcher.Launcher(
                cfg,
                token="t" * 24,
                command_runner=commands,
                process_factory=factory,
                which=lambda _value: "docker.exe",
            )
            runner._ready = True
            response = runner.handle_request(
                {
                    "token": "t" * 24,
                    "code": "print(1)",
                    "stdin": "",
                    "timeout_ms": 100,
                    "image": "evil/image:latest",
                    "runtime": "runc",
                    "network": "host",
                    "memory": "unlimited",
                    "pids_limit": 999999,
                    "user": "0:0",
                    "cap_add": ["SYS_ADMIN"],
                    "pull": "always",
                    "labels": {"com.openai.runner-strong.owner": "attacker"},
                }
            )
            self.assertEqual(response, {"ok": False, "error": "invalid_request"})
            self.assertIsNone(factory.argv)

    def test_authenticated_request_passes_only_job_json_on_stdin(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            cfg = config(Path(raw))
            commands = RecordingCommandRunner()
            factory = RecordingProcessFactory(
                {
                    "stdout": "ready\n",
                    "stderr": "",
                    "exit_code": 0,
                    "timed_out": False,
                    "output_limited": False,
                }
            )
            runner = launcher.Launcher(
                cfg,
                token="t" * 24,
                command_runner=commands,
                process_factory=factory,
                which=lambda _value: "docker.exe",
            )
            runner._ready = True
            response = runner.handle_request(
                {
                    "token": "t" * 24,
                    "code": "print(input())",
                    "stdin": "x\n",
                    "timeout_ms": 100,
                    "allowed_packages": ["numpy"],
                }
            )
            self.assertEqual(response["ok"], True)
            self.assertEqual(
                json.loads(factory.process.input_bytes),
                {
                    "code": "print(input())",
                    "stdin": "x\n",
                    "timeout_ms": 100,
                    "allowed_packages": ["numpy"],
                },
            )
            self.assertNotIn("t" * 24, factory.process.input_bytes.decode())
            self.assertIsNotNone(factory.kwargs)
            self.assertIs(factory.kwargs["shell"], False)

    def test_reaper_requires_exact_owned_labels(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            commands = RecordingCommandRunner()
            runner = launcher.Launcher(
                config(Path(raw)),
                token="t" * 24,
                command_runner=commands,
                which=lambda _value: "docker.exe",
            )
            commands.calls.clear()
            self.assertTrue(runner.reap_owned_containers("c" * 32))
            self.assertEqual(len(commands.calls), 1)
            call = commands.calls[0]
            self.assertIn("--filter=label=com.openai.runner-strong.owner=trusted-launcher", " ".join(call))
            self.assertIn("--filter=label=com.openai.runner-strong.managed=true", " ".join(call))
            self.assertIn("--filter=label=com.openai.runner-strong.job=" + "c" * 32, " ".join(call))
            self.assertNotIn("prune", call)

    def test_startup_self_probe_is_required_and_verifies_runtime_output(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            token_path = root / "token"
            token_path.write_text("t" * 24, encoding="ascii")
            token_path.chmod(stat.S_IRUSR | stat.S_IWUSR)
            commands = RecordingCommandRunner()
            factory = RecordingProcessFactory(
                {
                    "stdout": "strong-runtime-probe\n",
                    "stderr": "",
                    "exit_code": 0,
                    "timed_out": False,
                    "output_limited": False,
                }
            )
            runner = launcher.Launcher(
                config(root),
                command_runner=commands,
                process_factory=factory,
                which=lambda _value: "docker.exe",
            )

            with patch.object(launcher.LauncherConfig, "validate", return_value=None):
                with patch.object(launcher, "_safe_token_file", return_value="t" * 24):
                    runner.startup_check()

            self.assertTrue(runner._ready)
            self.assertIsNotNone(factory.argv)
            self.assertEqual(
                json.loads(factory.process.input_bytes)["code"],
                launcher.STARTUP_PROBE_CODE,
            )
            self.assertGreaterEqual(
                sum(call[1:3] == ["ps", "--all"] for call in commands.calls),
                3,
            )

    def test_startup_self_probe_failure_keeps_launcher_unready(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            token_path = root / "token"
            token_path.write_text("t" * 24, encoding="ascii")
            token_path.chmod(stat.S_IRUSR | stat.S_IWUSR)
            runner = launcher.Launcher(
                config(root),
                command_runner=RecordingCommandRunner(),
                process_factory=RecordingProcessFactory(
                    {
                        "stdout": "unexpected\n",
                        "stderr": "",
                        "exit_code": 0,
                        "timed_out": False,
                        "output_limited": False,
                    }
                ),
                which=lambda _value: "docker.exe",
            )

            with patch.object(launcher.LauncherConfig, "validate", return_value=None):
                with patch.object(launcher, "_safe_token_file", return_value="t" * 24):
                    with self.assertRaises(launcher.CapabilityError):
                        runner.startup_check()
            self.assertFalse(runner._ready)

    def test_infrastructure_budget_wraps_student_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            cfg = config(Path(raw))
            self.assertEqual(
                cfg.infrastructure_timeout_ms(100),
                100 + cfg.startup_grace_ms + cfg.cleanup_timeout_ms,
            )

    def test_student_timeout_is_a_normal_child_result(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            factory = RecordingProcessFactory(
                {
                    "stdout": "",
                    "stderr": "",
                    "exit_code": -9,
                    "timed_out": True,
                    "output_limited": False,
                }
            )
            runner = launcher.Launcher(
                config(Path(raw)),
                token="t" * 24,
                command_runner=RecordingCommandRunner(),
                process_factory=factory,
                which=lambda _value: "docker.exe",
            )
            runner._ready = True

            response = runner.handle_request(
                {"token": "t" * 24, "code": "while True: pass", "timeout_ms": 100}
            )

            self.assertEqual(response["ok"], True)
            self.assertTrue(response["timed_out"])
            self.assertEqual(response["exit_code"], -9)

    def test_startup_fails_closed_without_runsc_or_image(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            token_path = root / "token"
            token_path.write_text("t" * 24, encoding="ascii")
            token_path.chmod(stat.S_IRUSR | stat.S_IWUSR)
            commands = RecordingCommandRunner(runtime=False)
            runner = launcher.Launcher(
                config(root),
                command_runner=commands,
                which=lambda _value: "docker.exe",
            )
            with self.assertRaises(launcher.LauncherError):
                runner.startup_check()

    def test_digest_and_identity_configuration_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            with self.assertRaises(launcher.ConfigurationError):
                launcher.LauncherConfig(
                    socket_path=root / "launcher.sock",
                    token_file=root / "token",
                    image="registry.example.test/runner:latest",
                ).validate()
            with self.assertRaises(launcher.ConfigurationError):
                launcher.LauncherConfig(
                    socket_path=root / "launcher.sock",
                    token_file=root / "token",
                    image=IMAGE,
                    uid=0,
                ).validate()


if __name__ == "__main__":
    unittest.main()
