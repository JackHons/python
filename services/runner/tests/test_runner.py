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
from pathlib import Path


os.environ["RUNNER_DROP_PRIVILEGES"] = "0"
os.environ["RUNNER_MAX_OUTPUT_BYTES"] = "1024"
os.environ["RUNNER_SERVICE_TOKEN"] = "runner-test-token-at-least-24-chars"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import server  # noqa: E402


class ExecutionTests(unittest.TestCase):
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
