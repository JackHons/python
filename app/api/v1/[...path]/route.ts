const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function runtimeEnv(name: string) {
  const processLike = (globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }).process;
  return processLike?.env?.[name]?.trim() ?? "";
}

function errorResponse(code: string, message: string, status: number) {
  return Response.json({ error: { code, message } }, { status, headers: JSON_HEADERS });
}

async function proxy(request: Request) {
  // Use a dynamic lookup: vinext/Vite statically replaces dot-notation
  // process.env reads during the build, while these values must remain
  // runtime-only server configuration.
  const backendUrl = runtimeEnv("BACKEND_URL");
  const backendToken = runtimeEnv("BACKEND_INTERNAL_TOKEN");
  if (!backendUrl || !backendToken) return errorResponse("backend_unavailable", "Learning API is unavailable", 503);

  const incoming = new URL(request.url);
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("origin");
    if (!origin || origin !== incoming.origin) return errorResponse("csrf_failed", "Same-origin request required", 403);
  }

  const target = new URL(incoming.pathname + incoming.search, backendUrl);
  const headers = new Headers(request.headers);
  headers.set("x-backend-token", backendToken);
  headers.set("origin", target.origin);
  headers.delete("host");
  headers.delete("content-length");
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : request.body;
  const response = await fetch(target, {
    method: request.method,
    headers,
    body,
    ...(body ? { duplex: "half" } : {}),
  } as RequestInit & { duplex?: "half" });

  const output = new Headers();
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") output.set(key, value);
  });
  const responseHeaders = response.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = responseHeaders.getSetCookie?.() ?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie") as string] : []);
  for (const cookie of cookies) output.append("set-cookie", cookie);
  output.set("cache-control", "no-store");
  return new Response(response.body, { status: response.status, headers: output });
}

export const GET = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
