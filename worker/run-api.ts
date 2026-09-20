const DEFAULT_RUNNER_URL = "http://runner:8080";
const MAX_CODE_BYTES = 100 * 1024;
const MAX_STDIN_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = MAX_CODE_BYTES + MAX_STDIN_BYTES + 2_048;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 5_000;
const noStore = { "Cache-Control": "no-store" };

export type RunnerBindings = {
  PYTHON_RUNNER_URL?: string;
  PYTHON_RUNNER_TOKEN?: string;
};

type RunRequest = { code: string; stdin: string; timeout_ms: number };

type RunnerResult = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  output_limited: boolean;
  duration_ms?: number;
};

function validateRunRequest(value: unknown): RunRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !["code", "stdin", "timeout_ms"].includes(key))) {
    throw new Error("Request contains unsupported fields");
  }
  if (typeof body.code !== "string" || body.code.length === 0) {
    throw new Error("code must be a non-empty string");
  }
  if (new TextEncoder().encode(body.code).byteLength > MAX_CODE_BYTES) {
    throw new RangeError("code is too large");
  }
  const stdin = body.stdin === undefined ? "" : body.stdin;
  if (typeof stdin !== "string") throw new Error("stdin must be a string");
  if (new TextEncoder().encode(stdin).byteLength > MAX_STDIN_BYTES) {
    throw new RangeError("stdin is too large");
  }
  const timeout = body.timeout_ms === undefined ? 3_000 : body.timeout_ms;
  if (typeof timeout !== "number" || !Number.isInteger(timeout)) {
    throw new Error("timeout_ms must be an integer");
  }
  if (timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) {
    throw new Error(`timeout_ms must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  return { code: body.code, stdin, timeout_ms: timeout };
}

function validateRunnerResult(value: unknown): RunnerResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runner response must be an object");
  }
  const result = value as Record<string, unknown>;
  if (
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string" ||
    !(result.exit_code === null || Number.isInteger(result.exit_code)) ||
    typeof result.timed_out !== "boolean" ||
    typeof result.output_limited !== "boolean" ||
    !(result.duration_ms === undefined || Number.isInteger(result.duration_ms))
  ) {
    throw new Error("Runner response has an invalid shape");
  }
  return result as RunnerResult;
}

async function readBoundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("Request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      throw new RangeError("Request body is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

async function executeOnRunner(
  runRequest: RunRequest,
  bindings: RunnerBindings,
): Promise<Response> {
  const token = bindings.PYTHON_RUNNER_TOKEN?.trim();
  if (!token) {
    return Response.json(
      { error: "Python Runner 尚未配置" },
      { status: 503, headers: noStore },
    );
  }
  const runnerUrl = (bindings.PYTHON_RUNNER_URL || DEFAULT_RUNNER_URL).replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), runRequest.timeout_ms + 1_000);
  try {
    const upstream = await fetch(`${runnerUrl}/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(runRequest),
      signal: controller.signal,
    });
    const text = await upstream.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return Response.json(
        { error: upstream.status === 429 ? "Runner is busy; retry later" : "Runner returned non-JSON response" },
        { status: upstream.status === 429 ? 429 : 502, headers: noStore },
      );
    }
    if (!upstream.ok) {
      const message =
        payload &&
        typeof payload === "object" &&
        "error" in payload &&
        typeof payload.error === "string"
          ? payload.error
          : "Runner request failed";
      return Response.json(
        { error: message },
        { status: upstream.status === 429 ? 429 : 502, headers: noStore },
      );
    }
    try {
      return Response.json(validateRunnerResult(payload), { status: 200, headers: noStore });
    } catch {
      return Response.json(
        { error: "Runner returned an invalid response" },
        { status: 502, headers: noStore },
      );
    }
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "Runner request timed out"
        : "Unable to reach Python Runner";
    return Response.json({ error: message }, { status: 502, headers: noStore });
  } finally {
    clearTimeout(timer);
  }
}

export async function handleRunRequest(
  request: Request,
  bindings: RunnerBindings,
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405, headers: { ...noStore, Allow: "POST" } },
    );
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim();
  if (contentType !== "application/json") {
    return Response.json(
      { error: "Content-Type must be application/json" },
      { status: 415, headers: noStore },
    );
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return Response.json(
      { error: "Request body is too large" },
      { status: 413, headers: noStore },
    );
  }
  let body: unknown;
  try {
    body = await readBoundedJson(request);
  } catch (error) {
    return Response.json(
      { error: error instanceof RangeError ? error.message : "Request body must be valid JSON" },
      { status: error instanceof RangeError ? 413 : 400, headers: noStore },
    );
  }
  let validated: RunRequest;
  try {
    validated = validateRunRequest(body);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid request" },
      { status: error instanceof RangeError ? 413 : 400, headers: noStore },
    );
  }
  return executeOnRunner(validated, bindings);
}

