import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

const { createGatewayServer, portalRoleForPath } = await import("../gateway/server.mjs");

const TOKEN = "gateway-page-auth-internal-token-123456789";
const SESSION_COOKIE = "session=teacher-session";

const listen = (server) => new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});

const close = (server) => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
});

async function responseSnapshot(response) {
  return { status: response.status, headers: response.headers, body: await response.text() };
}

async function createHarness({ meStatus = 200, identity = { user: { id: "u-1", role: "teacher" } }, meBody, backendUnavailable = false } = {}) {
  const backendCalls = [];
  const webCalls = [];
  const backend = http.createServer((request, response) => {
    backendCalls.push({
      method: request.method,
      path: request.url,
      cookie: request.headers.cookie,
      token: request.headers["x-backend-token"],
      requestId: request.headers["x-request-id"],
    });
    if (request.url === "/api/v1/me") {
      response.writeHead(meStatus, { "content-type": "application/json" });
      response.end(meBody ?? JSON.stringify(identity));
      return;
    }
    if (request.url === "/ready") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}');
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  const web = http.createServer((request, response) => {
    webCalls.push({
      method: request.method,
      path: request.url,
      token: request.headers["x-backend-token"],
      requestId: request.headers["x-request-id"],
    });
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>stub web</title>");
  });
  const backendPort = await listen(backend);
  const webPort = await listen(web);
  if (backendUnavailable) await close(backend);
  const gateway = createGatewayServer({
    backendUrl: `http://127.0.0.1:${backendPort}`,
    webUrl: `http://127.0.0.1:${webPort}`,
    backendToken: TOKEN,
  });
  const gatewayPort = await listen(gateway);
  return {
    backendCalls,
    webCalls,
    base: `http://127.0.0.1:${gatewayPort}`,
    close: async () => Promise.all([close(gateway), backendUnavailable ? undefined : close(backend), close(web)]),
  };
}

test("role matcher covers static, dynamic and public compatibility page paths", () => {
  const expected = new Map([
    ["/student/dashboard", "student"],
    ["/student/courses/course-1/units/unit-2", "student"],
    ["/student/practice/submission-1", "student"],
    ["/teacher/analytics/ai", "teacher"],
    ["/teacher/courses/course-1/units/unit-2/materials", "teacher"],
    ["/teacher/assignments/a-1/submissions", "teacher"],
    ["/admin/dashboard", "admin"],
    ["/admin/settings/ai", "admin"],
    ["/admin/audit/events", "admin"],
    ["/", null],
    ["/dashboard", null],
    ["/courses", null],
    ["/classroom", null],
    ["/health", null],
    ["/api/v1/me", null],
  ]);
  for (const [pathname, role] of expected) assert.equal(portalRoleForPath(pathname), role, pathname);
});

test("GET and HEAD without a cookie return 401 without probing or forwarding", async () => {
  const harness = await createHarness();
  try {
    for (const method of ["GET", "HEAD"]) {
      const response = await fetch(`${harness.base}/teacher/dashboard`, { method, headers: { "x-request-id": `anonymous-${method}` } });
      const snapshot = await responseSnapshot(response);
      assert.equal(snapshot.status, 401);
      if (method === "HEAD") assert.equal(snapshot.body, "", method);
      else assert.match(snapshot.body, /sign in required/i);
      assert.equal(snapshot.headers.get("x-request-id"), `anonymous-${method}`);
    }
    assert.equal(harness.backendCalls.length, 0);
    assert.equal(harness.webCalls.length, 0);
  } finally {
    await harness.close();
  }
});

test("invalid session probe returns 401 and never reaches web", async () => {
  const harness = await createHarness({ meStatus: 401, identity: { error: { code: "unauthorized" } } });
  try {
    const response = await fetch(`${harness.base}/teacher/dashboard`, { headers: { cookie: "session=invalid-session", "x-request-id": "invalid-session-request" } });
    const snapshot = await responseSnapshot(response);
    assert.equal(snapshot.status, 401);
    assert.equal(harness.backendCalls.length, 1);
    assert.equal(harness.backendCalls[0].path, "/api/v1/me");
    assert.equal(harness.webCalls.length, 0);
  } finally {
    await harness.close();
  }
});

test("teacher page is forwarded after probe and private token stays off web", async () => {
  const harness = await createHarness();
  try {
    const response = await fetch(`${harness.base}/teacher/courses/course-1`, { headers: { cookie: SESSION_COOKIE, "x-request-id": "teacher-page-request" } });
    assert.equal(response.status, 200);
    assert.equal(harness.backendCalls.length, 1);
    assert.deepEqual(harness.backendCalls[0], {
      method: "GET",
      path: "/api/v1/me",
      cookie: SESSION_COOKIE,
      token: TOKEN,
      requestId: "teacher-page-request",
    });
    assert.equal(harness.webCalls.length, 1);
    assert.equal(harness.webCalls[0].path, "/teacher/courses/course-1");
    assert.equal(harness.webCalls[0].token, undefined);
    assert.equal(harness.webCalls[0].requestId, "teacher-page-request");
  } finally {
    await harness.close();
  }
});

test("student is denied teacher pages but may open a matching dynamic student page", async () => {
  const harness = await createHarness({ identity: { user: { id: "s-1", role: "student" } } });
  try {
    const denied = await responseSnapshot(await fetch(`${harness.base}/teacher/dashboard`, { headers: { cookie: "session=student-session", "x-request-id": "student-teacher-request" } }));
    assert.equal(denied.status, 403);
    assert.equal(harness.webCalls.length, 0);

    const allowed = await responseSnapshot(await fetch(`${harness.base}/student/courses/course-1/units/unit-2`, { headers: { cookie: "session=student-session", "x-request-id": "student-page-request" } }));
    assert.equal(allowed.status, 200);
    assert.equal(harness.webCalls.length, 1);
    assert.equal(harness.webCalls[0].path, "/student/courses/course-1/units/unit-2");
  } finally {
    await harness.close();
  }
});

test("admin may open nested admin pages", async () => {
  const harness = await createHarness({ identity: { user: { id: "a-1", role: "admin" } } });
  try {
    const response = await fetch(`${harness.base}/admin/settings/ai/providers`, { headers: { cookie: "session=admin-session" } });
    assert.equal(response.status, 200);
    assert.equal(harness.webCalls.length, 1);
    assert.equal(harness.webCalls[0].path, "/admin/settings/ai/providers");
  } finally {
    await harness.close();
  }
});

test("API paths bypass page probe and preserve existing backend forwarding", async () => {
  const harness = await createHarness({ identity: { user: { id: "s-1", role: "student" } } });
  try {
    const response = await fetch(`${harness.base}/api/v1/courses?scope=current`, { headers: { cookie: SESSION_COOKIE, "x-request-id": "api-request" } });
    assert.equal(response.status, 200);
    assert.deepEqual(harness.backendCalls.map(({ path }) => path), ["/api/v1/courses?scope=current"]);
    assert.equal(harness.backendCalls[0].token, TOKEN);
    assert.equal(harness.backendCalls[0].cookie, SESSION_COOKIE);
    assert.equal(harness.webCalls.length, 0);
  } finally {
    await harness.close();
  }
});

test("root, health and compatibility aliases bypass the role guard", async () => {
  const harness = await createHarness();
  try {
    for (const pathname of ["/", "/dashboard", "/courses", "/classroom"]) {
      const response = await fetch(harness.base + pathname);
      assert.equal(response.status, 200, pathname);
    }
    const health = await fetch(harness.base + "/health");
    assert.equal(health.status, 200);
    assert.equal(harness.backendCalls.filter(({ path }) => path === "/api/v1/me").length, 0);
    assert.equal(harness.webCalls.length, 5);
  } finally {
    await harness.close();
  }
});

test("page probe failures map to 502/503 and malformed identity maps to 502", async (t) => {
  await t.test("probe unavailable", async () => {
    const harness = await createHarness({ backendUnavailable: true });
    try {
      const response = await fetch(`${harness.base}/teacher/dashboard`, { headers: { cookie: SESSION_COOKIE } });
      assert.equal(response.status, 502);
      assert.equal(harness.webCalls.length, 0);
    } finally {
      await harness.close();
    }
  });
  await t.test("backend /me 5xx", async () => {
    const harness = await createHarness({ meStatus: 503, identity: { error: { code: "backend_down" } } });
    try {
      const response = await fetch(`${harness.base}/teacher/dashboard`, { headers: { cookie: SESSION_COOKIE } });
      assert.equal(response.status, 503);
      assert.equal(harness.webCalls.length, 0);
    } finally {
      await harness.close();
    }
  });
  await t.test("malformed identity", async () => {
    const harness = await createHarness({ meBody: JSON.stringify({ user: { id: "u-1", role: "not-a-role" } }) });
    try {
      const response = await fetch(`${harness.base}/teacher/dashboard`, { headers: { cookie: SESSION_COOKIE } });
      assert.equal(response.status, 502);
      assert.equal(harness.webCalls.length, 0);
    } finally {
      await harness.close();
    }
  });
});

test("denial response preserves request id and does not disclose session, token or upstream URLs", async () => {
  const harness = await createHarness({ identity: { user: { id: "s-1", role: "student" } } });
  try {
    const requestId = "denial-request-123";
    const response = await responseSnapshot(await fetch(`${harness.base}/teacher/dashboard`, {
      headers: { cookie: "session=super-secret-session", "x-request-id": requestId },
    }));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("x-request-id"), requestId);
    assert.doesNotMatch(response.body, /super-secret-session|gateway-page-auth-internal-token|127\.0\.0\.1|http:\/\//i);
    assert.equal(harness.webCalls.length, 0);
  } finally {
    await harness.close();
  }
});
