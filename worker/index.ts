/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { handleRunRequest, type RunnerBindings } from "./run-api";

interface Env extends RunnerBindings {
  ASSETS: Fetcher;
  DB: D1Database;
  BACKEND_URL?: string;
  BACKEND_INTERNAL_TOKEN?: string;
  NODE_ENV?: string;
  ALLOW_LEGACY_RUN?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env | undefined, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/run") {
      if ((env?.NODE_ENV ?? process.env.NODE_ENV) === "production" && (env?.ALLOW_LEGACY_RUN ?? process.env.ALLOW_LEGACY_RUN) !== "true") {
        return new Response(JSON.stringify({ error: { code: "legacy_route_disabled", message: "Legacy runner route is disabled" } }), { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      const runnerBindings: RunnerBindings = env ?? {
        PYTHON_RUNNER_URL: process.env.PYTHON_RUNNER_URL,
        PYTHON_RUNNER_TOKEN: process.env.PYTHON_RUNNER_TOKEN,
      };
      return handleRunRequest(request, runnerBindings);
    }

    if (url.pathname.startsWith("/api/v1/")) {
      const backendUrl = env?.BACKEND_URL ?? process.env.BACKEND_URL;
      const backendToken = env?.BACKEND_INTERNAL_TOKEN ?? process.env.BACKEND_INTERNAL_TOKEN;
      if (!backendUrl || !backendToken) return new Response(JSON.stringify({ error: { code: "backend_unavailable", message: "Learning API is unavailable" } }), { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      const target = new URL(url.pathname + url.search, backendUrl);
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        const origin = request.headers.get("origin");
        if (!origin || origin !== url.origin) return new Response(JSON.stringify({ error: { code: "csrf_failed", message: "Same-origin request required" } }), { status: 403, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      }
      const headers = new Headers(request.headers);
      headers.set("x-backend-token", backendToken);
      headers.set("origin", target.origin);
      headers.delete("host");
      // Node's undici requires an explicit duplex mode when forwarding a
      // streamed request body. Cloudflare ignores this extension, while the
      // cast keeps the Worker RequestInit type portable across runtimes.
      const body = ["GET", "HEAD"].includes(request.method) ? undefined : request.body;
      const response = await fetch(target, { method: request.method, headers, body, ...(body ? { duplex: "half" } : {}) } as RequestInit & { duplex?: "half" });
      const output = new Headers(response.headers);
      output.set("cache-control", "no-store");
      return new Response(response.body, { status: response.status, headers: output });
    }

    if (url.pathname === "/_vinext/image") {
      if (!env?.ASSETS || !env.IMAGES) {
        return new Response("Image service unavailable", { status: 503 });
      }
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
    }

    return handler.fetch(request, env, ctx);
  },
};

export default worker;
