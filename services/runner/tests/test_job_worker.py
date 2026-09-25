from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path


RUNNER_ROOT = Path(__file__).resolve().parents[1]
WORKER = RUNNER_ROOT / "job_worker.py"
sys.path.insert(0, str(RUNNER_ROOT))

from execution_policy import (  # noqa: E402
    MAX_CODE_BYTES,
    MAX_INPUT_BYTES,
    MAX_REQUEST_BYTES,
    validate_job_request,
)


class JobWorkerTests(unittest.TestCase):
    def run_worker(self, payload: object, raw: bytes | None = None) -> tuple[int, dict[str, object]]:
        body = raw if raw is not None else json.dumps(payload).encode("utf-8")
        completed = subprocess.run(
            [sys.executable, str(WORKER)],
            input=body,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
            timeout=10,
            env={"PATH": os.environ.get("PATH", "")},
        )
        self.assertEqual(completed.stderr, b"")
        return completed.returncode, json.loads(completed.stdout)

    def test_one_shot_protocol_executes_stdin_and_returns_server_shape(self) -> None:
        code, result = self.run_worker({"code": "print(input().upper())", "stdin": "ready\n", "timeout_ms": 1000})
        self.assertEqual(code, 0)
        self.assertEqual(result["stdout"], "READY\n")
        self.assertEqual(result["stderr"], "")
        self.assertEqual(result["exit_code"], 0)
        self.assertFalse(result["timed_out"])
        self.assertFalse(result["output_limited"])

    def test_policy_blocks_dangerous_capability_without_running_code(self) -> None:
        code, result = self.run_worker({"code": "import os\nprint('canary')"})
        self.assertEqual(code, 2)
        self.assertEqual(result, {"error": "code uses a blocked capability"})

    def test_timeout_and_output_are_bounded(self) -> None:
        timeout_code, timeout_result = self.run_worker({"code": "while True: pass", "timeout_ms": 100})
        self.assertEqual(timeout_code, 0)
        self.assertTrue(timeout_result["timed_out"])

        output_code, output_result = self.run_worker(
            {"code": "while True: print('x' * 200)", "timeout_ms": 1000}
        )
        self.assertEqual(output_code, 0)
        self.assertTrue(output_result["output_limited"])
        total = len(str(output_result["stdout"]).encode()) + len(str(output_result["stderr"]).encode())
        self.assertLessEqual(total, 65_536)

    def test_json_protocol_rejects_trailing_data_and_oversized_input(self) -> None:
        code, result = self.run_worker({}, raw=b'{"code":"print(1)"} trailing')
        self.assertEqual(code, 2)
        self.assertEqual(result, {"error": "Request body must be valid UTF-8 JSON"})

        code, result = self.run_worker({}, raw=b"{" + b"a" * MAX_REQUEST_BYTES)
        self.assertEqual(code, 2)
        self.assertEqual(result, {"error": "Request body is too large"})

    def test_policy_keeps_server_byte_limits(self) -> None:
        with self.assertRaisesRegex(ValueError, "code is too large"):
            validate_job_request({"code": "x" * (MAX_CODE_BYTES + 1)})
        with self.assertRaisesRegex(ValueError, "stdin is too large"):
            validate_job_request({"code": "print(1)", "stdin": "x" * (MAX_INPUT_BYTES + 1)})


if __name__ == "__main__":
    unittest.main()
