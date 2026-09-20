import assert from "node:assert/strict";
import test from "node:test";

const { handleRunRequest } = await import("../worker/run-api.ts");

test("runner proxy validates input and never exposes service credentials", async () => {
  const missing = await handleRunRequest(new Request("http://localhost/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "print(1)" }) }), {});
  assert.equal(missing.status, 503);
  assert.equal(JSON.stringify(await missing.json()).includes("replace"), false);

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ stdout: "ok\n", stderr: "", exit_code: 0, timed_out: false, output_limited: false, duration_ms: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    const response = await handleRunRequest(new Request("http://localhost/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "print(1)", timeout_ms: 1000 }) }), { PYTHON_RUNNER_TOKEN: "runner-token-that-stays-server-side" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { stdout: "ok\n", stderr: "", exit_code: 0, timed_out: false, output_limited: false, duration_ms: 1 });

    globalThis.fetch = async () => new Response(JSON.stringify({ error: "runner is busy; retry later" }), { status: 429, headers: { "content-type": "application/json" } });
    const busy = await handleRunRequest(new Request("http://localhost/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "print(1)" }) }), { PYTHON_RUNNER_TOKEN: "runner-token-that-stays-server-side" });
    assert.equal(busy.status, 429);
    assert.deepEqual(await busy.json(), { error: "runner is busy; retry later" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
