from __future__ import annotations

import json
import http.client
import importlib
import os
import queue
import sys
import tempfile
import threading
import unittest
import urllib.request
from dataclasses import replace
from unittest.mock import patch
from pathlib import Path


os.environ["RUNNER_DROP_PRIVILEGES"] = "0"
os.environ["RUNNER_MAX_OUTPUT_BYTES"] = "1024"
os.environ["RUNNER_SERVICE_TOKEN"] = "runner-test-token-at-least-24-chars"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server  # noqa: E402


class ExecutionTests(unittest.TestCase):
    def test_local_executor_is_explicitly_weak(self) -> None:
        capabilities = server.runner_capabilities()
        self.assertEqual(capabilities["status"], "ok")
        self.assertEqual(capabilities["isolation"]["mode"], "local_process")
        self.assertEqual(capabilities["isolation"]["strength"], "weak")
        self.assertFalse(capabilities["isolation"]["strong_verified"])
        self.assertFalse(capabilities["capabilities"]["egress_isolation"])

    def test_strong_required_fails_closed_without_external_executor(self) -> None:
        settings = replace(server.SETTINGS, require_strong_isolation=True)
        executor = server.LocalProcessExecutor(settings)
        capabilities = server.runner_capabilities(settings, executor)
        self.assertEqual(capabilities["status"], "not_ready")
        self.assertFalse(capabilities["ready"])
        self.assertTrue(capabilities["isolation"]["strong_required"])

    def test_strong_mode_never_falls_back_to_local_process(self) -> None:
        settings = replace(
            server.SETTINGS,
            isolation_mode=server.ISOLATION_MODE_STRONG_EXTERNAL,
            require_strong_isolation=False,
        )
        executor = server.create_executor(settings)
        self.assertIsInstance(executor, server.StrongExternalExecutor)
        capabilities = server.runner_capabilities(settings, executor)
        self.assertEqual(capabilities["status"], "not_ready")
        self.assertFalse(capabilities["isolation"]["fallback_used"])

    def test_strong_capability_reply_must_match_the_fixed_contract(self) -> None:
        settings = replace(
            server.SETTINGS,
            isolation_mode=server.ISOLATION_MODE_STRONG_EXTERNAL,
            strong_socket_path="/run/runner-strong/launcher.sock",
            strong_token="t" * 24,
        )
        valid = {
            "ok": True,
            "capabilities": {
                "protocol": server.STRONG_EXECUTOR_PROTOCOL,
                "version": server.STRONG_EXECUTOR_PROTOCOL_VERSION,
                "ready": True,
                "runtime": "runsc",
                "disposable": True,
                "network": "none",
                "readOnlyRoot": True,
                "nonRoot": True,
                "resourceLimits": True,
                "imagePinned": True,
            },
        }
        with patch.object(server, "_strong_socket_request", return_value=valid):
            executor = server.StrongExternalExecutor(settings)
            capabilities = server.runner_capabilities(settings, executor)
        self.assertEqual(capabilities["status"], "ok")
        self.assertEqual(capabilities["isolation"]["strength"], "strong")
        self.assertTrue(capabilities["isolation"]["strong_verified"])
        self.assertTrue(capabilities["capabilities"]["egress_isolation"])

        invalid = {**valid, "capabilities": {**valid["capabilities"], "runtime": "runc"}}
        with patch.object(server, "_strong_socket_request", return_value=invalid):
            executor = server.StrongExternalExecutor(settings)
            capabilities = server.runner_capabilities(settings, executor)
        self.assertEqual(capabilities["status"], "not_ready")
        self.assertFalse(capabilities["isolation"]["strong_verified"])

    def test_strong_executor_sends_only_bounded_job_fields_and_never_falls_back(self) -> None:
        settings = replace(
            server.SETTINGS,
            isolation_mode=server.ISOLATION_MODE_STRONG_EXTERNAL,
            strong_socket_path="/run/runner-strong/launcher.sock",
            strong_token="t" * 24,
        )
        capability = {
            "ok": True,
            "capabilities": {
                "protocol": server.STRONG_EXECUTOR_PROTOCOL,
                "version": server.STRONG_EXECUTOR_PROTOCOL_VERSION,
                "ready": True,
                "runtime": "runsc",
                "disposable": True,
                "network": "none",
                "readOnlyRoot": True,
                "nonRoot": True,
                "resourceLimits": True,
                "imagePinned": True,
            },
        }
        result = {
            "ok": True,
            "stdout": "ok\n",
            "stderr": "",
            "exit_code": 0,
            "timed_out": False,
            "output_limited": False,
            "duration_ms": 7,
        }
        with patch.object(server, "_strong_socket_request", side_effect=[capability, result]) as request:
            executor = server.StrongExternalExecutor(settings)
            actual = executor.execute("print(1)", "", 1000, allowed_packages=("numpy",))
        self.assertEqual(actual["stdout"], "ok\n")
        job_payload = request.call_args_list[1].args[1]
        self.assertEqual(
            set(job_payload), {"token", "code", "stdin", "timeout_ms", "allowed_packages"}
        )
        self.assertNotIn("image", job_payload)
        self.assertNotIn("runtime", job_payload)

    def test_strong_executor_failure_is_fail_closed(self) -> None:
        settings = replace(
            server.SETTINGS,
            isolation_mode=server.ISOLATION_MODE_STRONG_EXTERNAL,
            strong_socket_path="/run/runner-strong/launcher.sock",
            strong_token="t" * 24,
        )
        with patch.object(server, "_strong_socket_request", side_effect=server.RunnerNotReady):
            executor = server.StrongExternalExecutor(settings)
            with self.assertRaises(server.RunnerNotReady):
                executor.execute("print(1)", "", 1000)
            self.assertFalse(executor.available)

    def test_invalid_isolation_mode_is_rejected_at_configuration(self) -> None:
        with patch.dict(os.environ, {"RUNNER_ISOLATION_MODE": "not-a-mode"}):
            with self.assertRaisesRegex(RuntimeError, "RUNNER_ISOLATION_MODE"):
                server.Settings.from_env()

    def test_child_environment_is_positive_allowlist_without_service_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            child_env = server.build_child_env(server.SETTINGS, Path(temporary), 1000)
        self.assertNotIn("RUNNER_SERVICE_TOKEN", child_env)
        self.assertNotIn("PYTHON_RUNNER_TOKEN", child_env)
        self.assertNotIn("BACKEND_INTERNAL_TOKEN", child_env)
        self.assertNotIn("AI_MASTER_KEY", child_env)
        self.assertNotIn("SMTP_PASSWORD", child_env)
    def test_executes_code_with_stdin(self) -> None:
        result = server.execute_python("print(input().upper())", "student\n", 1000)
        self.assertEqual(result["stdout"], "STUDENT\n")
        self.assertEqual(result["stderr"], "")
        self.assertEqual(result["exit_code"], 0)
        self.assertFalse(result["timed_out"])

    def test_stops_timeout(self) -> None:
        result = server.execute_python("while True: pass", "", 150)
        self.assertTrue(result["timed_out"])
        self.assertNotEqual(result["exit_code"], 0)

    def test_limits_output(self) -> None:
        result = server.execute_python("while True: print('x' * 200)", "", 1000)
        total = len(result["stdout"].encode()) + len(result["stderr"].encode())
        self.assertTrue(result["output_limited"])
        self.assertLessEqual(total, 1024)

    def test_course_package_allowlist_keeps_stdlib_and_blocks_unlisted_third_party(self) -> None:
        self.assertTrue(server.is_stdlib_module("math"))
        self.assertTrue(server.is_stdlib_module("json"))
        self.assertTrue(server.is_stdlib_module("sys"))
        self.assertFalse(server.is_stdlib_module("flask"))
        server.validate_code_policy("import math\nprint(math.sqrt(4))")
        for package in ("numpy", "pandas", "matplotlib"):
            server.validate_code_policy(f"import {package}", (package,))
            with self.assertRaisesRegex(server.CodePolicyError, "not enabled"):
                server.validate_code_policy(f"import {package}")
        with self.assertRaisesRegex(server.CodePolicyError, "not enabled"):
            server.validate_code_policy("import flask", ("numpy",))
        with self.assertRaisesRegex(server.CodePolicyError, "blocked capability"):
            server.validate_code_policy("import pip", ("numpy",))

    def test_stdlib_fallback_rejects_nested_package_manager_directories(self) -> None:
        original_stdlib = server.STDLIB_PATHS
        original_third_party = server.THIRD_PARTY_PATHS
        had_known_names = hasattr(sys, "stdlib_module_names")
        original_known_names = getattr(sys, "stdlib_module_names", None)
        with tempfile.TemporaryDirectory() as temporary:
            stdlib_root = Path(temporary) / "stdlib"
            for directory_name in ("site-packages", "dist-packages"):
                module_name = f"runner_untrusted_{directory_name.replace('-', '_')}"
                module_root = stdlib_root / "vendor" / directory_name
                module_root.mkdir(parents=True, exist_ok=True)
                (module_root / f"{module_name}.py").write_text("VALUE = 1\n", encoding="utf-8")
                sys.path.insert(0, str(module_root))
                try:
                    server.STDLIB_PATHS = (stdlib_root.resolve(),)
                    # Deliberately omit the nested vendor path from the
                    # configured third-party roots: the path component itself
                    # must still make the module untrusted.
                    server.THIRD_PARTY_PATHS = ()
                    if had_known_names:
                        sys.stdlib_module_names = frozenset(original_known_names) | {module_name}
                    importlib.invalidate_caches()
                    self.assertFalse(server.is_stdlib_module(module_name))
                    with self.assertRaisesRegex(server.CodePolicyError, "not enabled"):
                        server.validate_code_policy(f"import {module_name}")
                finally:
                    sys.path.remove(str(module_root))
                    sys.modules.pop(module_name, None)
                    importlib.invalidate_caches()
                    server.STDLIB_PATHS = original_stdlib
                    server.THIRD_PARTY_PATHS = original_third_party
                    if had_known_names:
                        sys.stdlib_module_names = original_known_names


class HealthTests(unittest.TestCase):
    def test_health_endpoint(self) -> None:
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.RunnerHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            with urllib.request.urlopen(
                f"http://127.0.0.1:{httpd.server_port}/health", timeout=1
            ) as response:
                self.assertEqual(response.status, 200)
                self.assertEqual(json.load(response), {"status": "ok"})
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=1)

    def test_capabilities_and_ready_endpoints_are_bounded(self) -> None:
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.RunnerHandler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            for path in ("/ready", "/capabilities"):
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{httpd.server_port}{path}", timeout=1
                ) as response:
                    payload = json.load(response)
                    self.assertEqual(response.status, 200)
                    self.assertEqual(payload["isolation"]["mode"], "local_process")
                    self.assertNotIn("service_token", json.dumps(payload))
        finally:
            httpd.shutdown()
            httpd.server_close()
            thread.join(timeout=1)


class ExecuteHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.RunnerHandler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=1)

    def request(
        self,
        body: bytes,
        *,
        content_type: str = "application/json",
        token: str | None = os.environ["RUNNER_SERVICE_TOKEN"],
    ) -> tuple[int, dict[str, object]]:
        connection = http.client.HTTPConnection(
            "127.0.0.1", self.httpd.server_port, timeout=2
        )
        headers = {"Content-Type": content_type, "Content-Length": str(len(body))}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        connection.request("POST", "/execute", body=body, headers=headers)
        response = connection.getresponse()
        payload = json.loads(response.read())
        connection.close()
        return response.status, payload

    def test_requires_service_token(self) -> None:
        status, payload = self.request(b'{"code":"print(1)"}', token=None)
        self.assertEqual(status, 401)
        self.assertEqual(payload, {"error": "unauthorized"})

    def test_rejects_wrong_content_type(self) -> None:
        status, payload = self.request(b'{"code":"print(1)"}', content_type="text/plain")
        self.assertEqual(status, 415)
        self.assertIn("Content-Type", str(payload["error"]))

    def test_rejects_invalid_json_shape(self) -> None:
        status, _ = self.request(b"[]")
        self.assertEqual(status, 400)

    def test_request_cannot_select_isolation_mode(self) -> None:
        status, payload = self.request(
            json.dumps({"code": "print(1)", "isolation_mode": "strong_external"}).encode()
        )
        self.assertEqual(status, 400)
        self.assertEqual(payload, {"error": "Request contains unsupported fields"})

    def test_http_execution_fails_closed_when_strong_mode_is_required(self) -> None:
        previous_settings = server.SETTINGS
        previous_executor = server.RUNNER_EXECUTOR
        try:
            server.SETTINGS = replace(
                previous_settings,
                isolation_mode=server.ISOLATION_MODE_STRONG_EXTERNAL,
                require_strong_isolation=False,
            )
            server.RUNNER_EXECUTOR = server.StrongExternalExecutor()
            status, payload = self.request(b'{"code":"print(1)"}')
            self.assertEqual(status, 503)
            self.assertEqual(
                payload,
                {"error": "runner is not ready", "code": "runner_not_ready"},
            )
        finally:
            server.SETTINGS = previous_settings
            server.RUNNER_EXECUTOR = previous_executor

    def test_executes_authorized_request(self) -> None:
        status, payload = self.request(
            json.dumps({"code": "print(input())", "stdin": "ready\n"}).encode()
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["stdout"], "ready\n")

    def test_rejects_packages_not_in_server_allowlist(self) -> None:
        status, payload = self.request(json.dumps({"code": "import flask", "allowed_packages": ["flask"]}).encode())
        self.assertEqual(status, 422)
        self.assertIn("unsupported package", str(payload["error"]))

    def test_rejects_dangerous_capabilities_without_echoing_source(self) -> None:
        canary = "hidden-network-canary-7e8d"
        for code in [
            "import os\nprint('" + canary + "')",
            "import subprocess",
            "import socket",
            "__import__('os')",
            "fork()",
            "import pip",
        ]:
            status, payload = self.request(json.dumps({"code": code}).encode())
            self.assertEqual(status, 422)
            self.assertEqual(payload, {"error": "code uses a blocked capability"})
            self.assertNotIn(canary, json.dumps(payload))

    def test_returns_429_when_bounded_runner_is_busy(self) -> None:
        previous = server.EXECUTION_IDENTITIES
        server.EXECUTION_IDENTITIES = queue.LifoQueue(1)
        try:
            status, payload = self.request(b'{"code":"print(1)"}')
            self.assertEqual(status, 429)
            self.assertEqual(payload, {"error": "runner is busy; retry later"})
        finally:
            server.EXECUTION_IDENTITIES = previous


if __name__ == "__main__":
    unittest.main()
