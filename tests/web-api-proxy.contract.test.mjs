import assert from "node:assert/strict";
import test from "node:test";

const previousBackend = process.env.BACKEND_URL;
const previousToken = process.env.BACKEND_INTERNAL_TOKEN;
process.env.BACKEND_URL = "http://backend.test:8787";
process.env.BACKEND_INTERNAL_TOKEN = "proxy-contract-token-1234567890";
const route = await import("../app/api/v1/[...path]/route.ts");

test.after(() => {
  if (previousBackend === undefined) delete process.env.BACKEND_URL; else process.env.BACKEND_URL = previousBackend;
  if (previousToken === undefined) delete process.env.BACKEND_INTERNAL_TOKEN; else process.env.BACKEND_INTERNAL_TOKEN = previousToken;
});

test("web API proxy forwards server token, body, status and Set-Cookie without caching", async () => {
  const originalFetch = globalThis.fetch;
  let forwarded;
  globalThis.fetch = async (target, init) => {
    forwarded = { target: String(target), init };
    return new Response(JSON.stringify({ user: { id: "u1" } }), {
      status: 201,
      headers: [["content-type", "application/json"], ["set-cookie", "session=opaque; HttpOnly"]],
    });
  };
  try {
    const response = await route.POST(new Request("http://localhost:3000/api/v1/auth/login?next=1", {
      method: "POST",
      headers: { origin: "http://localhost:3000", cookie: "old=session" },
      body: JSON.stringify({ username: "teacher" }),
    }));
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("set-cookie") ?? "", /session=opaque/);
    assert.equal(forwarded.target, "http://backend.test:8787/api/v1/auth/login?next=1");
    assert.equal(forwarded.init.headers.get("x-backend-token"), "proxy-contract-token-1234567890");
    assert.equal(forwarded.init.headers.get("origin"), "http://backend.test:8787");
    assert.equal(await new Response(forwarded.init.body).text(), JSON.stringify({ username: "teacher" }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web API proxy rejects cross-origin mutations before contacting backend", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response("unexpected"); };
  try {
    const response = await route.POST(new Request("http://localhost:3000/api/v1/auth/login", {
      method: "POST",
      headers: { origin: "https://evil.example" },
      body: "{}",
    }));
    assert.equal(response.status, 403);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
