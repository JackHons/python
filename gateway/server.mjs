import http from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PORTAL_ROLES = new Map([["/student", "student"], ["/teacher", "teacher"], ["/admin", "admin"]]);
const VALID_ROLES = new Set(PORTAL_ROLES.values());

function isApiPath(pathname) {
  return pathname === "/api/v1" || pathname.startsWith("/api/v1/");
}

export function portalRoleForPath(pathname) {
  const value = String(pathname ?? "");
  for (const [prefix, role] of PORTAL_ROLES) if (value === prefix || value.startsWith(prefix + "/")) return role;
  return null;
}

function headerRecord(headers) {
  const result = {};
  headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") result[key] = value;
  });
  const getSetCookie = headers.getSetCookie?.bind(headers);
  const cookies = getSetCookie?.() ?? [];
  if (cookies.length) result["set-cookie"] = cookies;
  return result;
}

function json(res, status, body, requestId) {
  const encoded = Buffer.from(JSON.stringify({ error: body }));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": encoded.length, "x-request-id": requestId });
  res.end(encoded);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function pageError(res, request, status, code, requestId) {
  const title = status === 401 ? "Sign in required" : status === 403 ? "Access denied" : "Service unavailable";
  const message = status === 401 ? "Please sign in to continue." : status === 403 ? "Your account cannot access this page." : "The learning platform is temporarily unavailable.";
  const currentUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "gateway"}`);
  const returnTo = status === 401 ? `/?returnTo=${encodeURIComponent(currentUrl.pathname + currentUrl.search)}` : "/";
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p>${status === 401 ? `<a href="${escapeHtml(returnTo)}">Go to sign in</a>` : `<a href="/">Return home</a>`}</main></body></html>`;
  const encoded = Buffer.from(body);
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-length": encoded.length, "x-request-id": requestId, "x-error-code": code });
  if (String(request.method ?? "GET").toUpperCase() === "HEAD") return res.end();
  return res.end(encoded);
}

function requestPublicOrigin(req) {
  const host = String(req.headers.host ?? "").trim().toLowerCase();
  if (!host || /[\s/\\]/.test(host)) return null;
  return `http://${host}`;
}

function originAllowed(req, allowedOrigins, backendToken) {
  if (!MUTATION_METHODS.has(String(req.method ?? "GET").toUpperCase())) return true;
  const origin = String(req.headers.origin ?? "").trim();
  if (!origin) return String(req.headers["x-backend-token"] ?? "") === backendToken;
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  const normalized = parsed.origin.toLowerCase();
  return normalized === requestPublicOrigin(req)?.toLowerCase() || allowedOrigins.has(normalized);
}

function hasSessionCookie(req) {
  return String(req.headers.cookie ?? "").split(";").some((part) => part.trim().toLowerCase().startsWith("session="));
}

async function probeSession(req, backendUrl, backendToken, requestId) {
  if (!hasSessionCookie(req)) return { status: 401, code: "unauthorized" };
  const headers = new Headers({ accept: "application/json", cookie: String(req.headers.cookie), "x-backend-token": backendToken, "x-request-id": requestId });
  try {
    const response = await fetch(`${backendUrl}/api/v1/me`, { method: "GET", headers });
    if (response.status === 401 || (response.status >= 400 && response.status < 500)) return { status: 401, code: "unauthorized" };
    if (response.status >= 500) return { status: 503, code: "auth_upstream_unavailable" };
    if (!response.ok) return { status: 502, code: "auth_upstream_invalid" };
    let payload;
    try { payload = await response.json(); } catch { return { status: 502, code: "auth_upstream_invalid" }; }
    const role = payload?.user?.role;
    if (!VALID_ROLES.has(role)) return { status: 502, code: "auth_upstream_invalid" };
    return { status: 200, role };
  } catch {
    return { status: 502, code: "auth_upstream_unavailable" };
  }
}

export function createGatewayServer(options = {}) {
  const backendUrl = String(options.backendUrl ?? process.env.BACKEND_URL ?? "").replace(/\/$/, "");
  const webUrl = String(options.webUrl ?? process.env.WEB_URL ?? "").replace(/\/$/, "");
  const backendToken = String(options.backendToken ?? process.env.BACKEND_INTERNAL_TOKEN ?? "");
  const maxRequestBytes = Number(options.maxRequestBytes ?? process.env.GATEWAY_MAX_REQUEST_BYTES ?? 35 * 1024 * 1024);
  const allowedOrigins = new Set(String(options.publicOrigins ?? process.env.PUBLIC_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean).map((value) => {
    try { return new URL(value).origin.toLowerCase(); } catch { throw new Error("PUBLIC_ORIGINS must contain valid absolute origins"); }
  }));
  if (!backendUrl || !webUrl || backendToken.length < 24) throw new Error("BACKEND_URL, WEB_URL and a 24+ character BACKEND_INTERNAL_TOKEN are required");

  async function proxy(req, res) {
  const requestId = String(req.headers["x-request-id"] ?? "").slice(0, 128) || randomUUID();
  const incoming = new URL(req.url ?? "/", `http://${req.headers.host ?? "gateway"}`);
  if (incoming.pathname === "/health") {
    try {
      const [backend, web] = await Promise.all([fetch(`${backendUrl}/ready`), fetch(`${webUrl}/`)]);
      if (!backend.ok || !web.ok) return json(res, 503, { code: "upstream_unhealthy", message: "Gateway upstream is not ready" }, requestId);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-request-id": requestId });
      return res.end(JSON.stringify({ status: "ok", backend: "ready", web: "ready" }));
    } catch {
      return json(res, 503, { code: "upstream_unavailable", message: "Gateway upstream is unavailable" }, requestId);
    }
  }

  const api = isApiPath(incoming.pathname);
  if (api && !originAllowed(req, allowedOrigins, backendToken)) {
    return json(res, 403, { code: "csrf_failed", message: "Same-origin request required" }, requestId);
  }
  const method = String(req.method ?? "GET").toUpperCase();
  const pageRole = !api && (method === "GET" || method === "HEAD") ? portalRoleForPath(incoming.pathname) : null;
  if (pageRole) {
    const auth = await probeSession(req, backendUrl, backendToken, requestId);
    if (auth.status !== 200) return pageError(res, req, auth.status, auth.code, requestId);
    if (auth.role !== pageRole) return pageError(res, req, 403, "role_forbidden", requestId);
  }
  const upstream = api ? backendUrl : webUrl;
  const target = new URL(incoming.pathname + incoming.search, `${upstream}/`);
  const length = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(length) && length > maxRequestBytes) return json(res, 413, { code: "request_too_large", message: "Request body is too large" }, requestId);
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("x-backend-token");
  headers.set("x-request-id", requestId);
  if (api) {
    headers.set("x-backend-token", backendToken);
    // External Origin has already been checked. The private backend also
    // authenticates this hop and compares against its own URL.
    headers.set("origin", new URL(backendUrl).origin);
  }
  const hasBody = !["GET", "HEAD"].includes(req.method ?? "GET");
  try {
    const response = await fetch(target, {
      method: req.method,
      headers,
      body: hasBody ? req : undefined,
      ...(hasBody ? { duplex: "half" } : {}),
    });
    const output = headerRecord(response.headers);
    output["cache-control"] = "no-store";
    output["x-request-id"] = output["x-request-id"] || requestId;
    res.writeHead(response.status, output);
    if (!response.body) return res.end();
    Readable.fromWeb(response.body).pipe(res);
  } catch (error) {
    if (!res.headersSent) json(res, 502, { code: "upstream_unavailable", message: "Upstream service is unavailable" }, requestId);
    else res.destroy(error);
  }
}

  return http.createServer((req, res) => { void proxy(req, res); });
}

function main() {
  const port = Number(process.env.GATEWAY_PORT ?? 3000);
  const server = createGatewayServer();
  server.listen(port, "0.0.0.0", () => process.stdout.write(`gateway listening on ${port}\n`));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
