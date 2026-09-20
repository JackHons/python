import http from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isApiPath(pathname) {
  return pathname === "/api/v1" || pathname.startsWith("/api/v1/");
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
