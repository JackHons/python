import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

const { createGatewayServer } = await import("../gateway/server.mjs");
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

test("gateway rejects evil browser Origin before forwarding and accepts public same-origin", async () => {
  const calls = [];
  const backend = http.createServer((request, response) => {
    calls.push({ origin: request.headers.origin, token: request.headers["x-backend-token"] });
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  const web = http.createServer((_request, response) => response.end("web"));
  const backendPort = await listen(backend);
  const webPort = await listen(web);
  const token = "gateway-integration-token-123456789";
  const gateway = createGatewayServer({ backendUrl: `http://127.0.0.1:${backendPort}`, webUrl: `http://127.0.0.1:${webPort}`, backendToken: token });
  const gatewayPort = await listen(gateway);
  const base = `http://127.0.0.1:${gatewayPort}`;
  try {
    const evil = await fetch(base + "/api/v1/auth/login", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" });
    assert.equal(evil.status, 403);
    assert.ok(evil.headers.get("x-request-id"));
    assert.equal((await evil.json()).error.code, "csrf_failed");
    assert.equal(calls.length, 0);

    const accepted = await fetch(base + "/api/v1/auth/login", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: "{}" });
    assert.equal(accepted.status, 200);
    assert.ok(accepted.headers.get("x-request-id"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].origin, `http://127.0.0.1:${backendPort}`);
    assert.equal(calls[0].token, token);

    const missingOrigin = await fetch(base + "/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(missingOrigin.status, 403);
    const internal = await fetch(base + "/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-backend-token": token }, body: "{}" });
    assert.equal(internal.status, 200);
    assert.equal(calls.length, 2);
  } finally {
    await Promise.all([close(gateway), close(backend), close(web)]);
  }
});
