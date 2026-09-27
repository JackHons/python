import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const { assertDatabaseIntegrity, openLocalDatabase } = await import("../server/db.ts");
const { BackupService } = await import("../server/backups/service.ts");

const workspace = resolve(process.cwd());
const sourceProject = process.env.SOURCE_COMPOSE_PROJECT ?? "phase11-deploy-20260921";
const sourceServices = {
  backend: `${sourceProject}-backend-1`,
  gateway: `${sourceProject}-gateway-1`,
  web: `${sourceProject}-web-1`,
  runner: `${sourceProject}-runner-1`,
  converter: `${sourceProject}-converter-1`,
  emailWorker: `${sourceProject}-email-worker-1`,
};
const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const composeProject = `phase11-c2c-7b4e-${stamp}`;
const evidencePath = resolve(workspace, "docs/移植交接/c2c_7b4e_restore_upload_smoke.txt");

function docker(args, options = {}) {
  try {
    return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
  } catch (error) {
    const command = ["docker", ...args].join(" ").replace(/(TOKEN|PASSWORD|KEY|SECRET)=\S+/gi, "$1=[redacted]");
    const failure = new Error(`${command} failed`, { cause: error });
    failure.code = "docker_command_failed";
    throw failure;
  }
}

function inspectImage(container) {
  return docker(["inspect", "--format", "{{.Config.Image}}", container]);
}

function inspectEnv(container) {
  const raw = docker(["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", container]);
  return Object.fromEntries(raw.split(/\r?\n/).filter(Boolean).map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

function yaml(value) {
  return JSON.stringify(String(value));
}

function bindPath(value) {
  return value.replaceAll("\\", "/");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJsonOutput(value) {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]); } catch { /* Find the JSON line after node startup noise. */ }
  }
  throw new Error("Expected JSON output from the migration helper");
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

function composeFile({ root, port, images, sourceEnv }) {
  const db = bindPath(join(root, "db"));
  const storage = bindPath(join(root, "storage"));
  const exportsRoot = bindPath(join(root, "exports"));
  const backups = bindPath(join(root, "backups"));
  const backendToken = sourceEnv.BACKEND_INTERNAL_TOKEN;
  const runnerToken = sourceEnv.PYTHON_RUNNER_TOKEN ?? sourceEnv.RUNNER_SERVICE_TOKEN;
  const aiKey = sourceEnv.AI_MASTER_KEY;
  if (!backendToken || backendToken.length < 24 || !runnerToken || runnerToken.length < 24 || !aiKey) {
    throw new Error("The source deployment did not expose the required private service configuration");
  }
  const lines = [
    "services:",
    "  runner:",
    `    image: ${yaml(images.runner)}`,
    "    environment:",
    "      RUNNER_HOST: 0.0.0.0",
    "      RUNNER_PORT: \"8080\"",
    "      RUNNER_MAX_CODE_BYTES: \"102400\"",
    "      RUNNER_MAX_INPUT_BYTES: \"65536\"",
    "      RUNNER_MAX_REQUEST_BYTES: \"196608\"",
    "      RUNNER_MAX_OUTPUT_BYTES: \"65536\"",
    "      RUNNER_MAX_TIMEOUT_MS: \"5000\"",
    "      RUNNER_DEFAULT_TIMEOUT_MS: \"3000\"",
    "      RUNNER_MAX_CONCURRENCY: \"4\"",
    "      RUNNER_MEMORY_MB: \"768\"",
    "      RUNNER_MAX_FILE_BYTES: \"5242880\"",
    "      RUNNER_CHILD_PROCESS_COUNT: \"32\"",
    "      RUNNER_SANDBOX_UID: \"10001\"",
    "      RUNNER_SANDBOX_GID: \"10001\"",
    "      RUNNER_DROP_PRIVILEGES: \"1\"",
    "      RUNNER_REQUEST_TIMEOUT_MS: \"3000\"",
    "      RUNNER_ISOLATION_MODE: local_process",
    "      RUNNER_REQUIRE_STRONG_ISOLATION: \"0\"",
    `      RUNNER_SERVICE_TOKEN: ${yaml(runnerToken)}`,
    "    healthcheck:",
    "      test: [\"CMD\", \"python\", \"-c\", \"import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2)\"]",
    "      interval: 5s",
    "      timeout: 3s",
    "      retries: 12",
    "      start_period: 5s",
    "    networks: [runner-internal]",
    "  backend:",
    `    image: ${yaml(images.backend)}`,
    "    command: [\"npm\", \"run\", \"backend\"]",
    "    environment:",
    "      NODE_ENV: production",
    "      BACKEND_PORT: \"8787\"",
    "      BACKEND_HOST: 0.0.0.0",
    `      BACKEND_INTERNAL_TOKEN: ${yaml(backendToken)}`,
    "      SESSION_COOKIE_SECURE: \"false\"",
    "      DATABASE_PATH: /data/db/learning.sqlite",
    "      STORAGE_ROOT: /data/storage",
    "      EXPORT_STORAGE_ROOT: /data/exports",
    "      BACKUP_ROOT: /data/backups",
    "      BACKUP_ENABLED: \"false\"",
    `      AI_MASTER_KEY: ${yaml(aiKey)}`,
    "      PYTHON_RUNNER_URL: http://runner:8080",
    `      PYTHON_RUNNER_TOKEN: ${yaml(runnerToken)}`,
    "    volumes:",
    `      - ${yaml(`${db}:/data/db`)}`,
    `      - ${yaml(`${storage}:/data/storage`)}`,
    `      - ${yaml(`${exportsRoot}:/data/exports`)}`,
    `      - ${yaml(`${backups}:/data/backups`)}`,
    "    depends_on:",
    "      runner:",
    "        condition: service_healthy",
    "    healthcheck:",
    "      test: [\"CMD\", \"node\", \"-e\", \"fetch('http://127.0.0.1:8787/ready').then(r => r.ok ? r.json() : Promise.reject()).then(x => x.status === 'ok' || Promise.reject()).catch(() => process.exit(1))\"]",
    "      interval: 5s",
    "      timeout: 3s",
    "      retries: 20",
    "      start_period: 20s",
    "    networks: [web, runner-internal]",
    "  web:",
    `    image: ${yaml(images.web)}`,
    "    environment:",
    "      NODE_ENV: production",
    "      ALLOW_LEGACY_RUN: \"false\"",
    "    depends_on:",
    "      backend:",
    "        condition: service_healthy",
    "    healthcheck:",
    "      test: [\"CMD\", \"node\", \"-e\", \"fetch('http://127.0.0.1:3000/').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))\"]",
    "      interval: 5s",
    "      timeout: 3s",
    "      retries: 20",
    "      start_period: 20s",
    "    networks: [web]",
    "  gateway:",
    `    image: ${yaml(images.gateway)}`,
    "    environment:",
    "      NODE_ENV: production",
    "      GATEWAY_PORT: \"3000\"",
    "      BACKEND_URL: http://backend:8787",
    "      WEB_URL: http://web:3000",
    `      PUBLIC_ORIGINS: ${yaml(`http://127.0.0.1:${port},http://localhost:${port}`)}`,
    `      BACKEND_INTERNAL_TOKEN: ${yaml(backendToken)}`,
    `    ports: [${yaml(`127.0.0.1:${port}:3000`)}]`,
    "    depends_on:",
    "      backend:",
    "        condition: service_healthy",
    "      web:",
    "        condition: service_healthy",
    "    healthcheck:",
    "      test: [\"CMD\", \"node\", \"-e\", \"fetch('http://127.0.0.1:3000/health').then(r => r.ok ? r.json() : Promise.reject()).catch(() => process.exit(1))\"]",
    "      interval: 5s",
    "      timeout: 4s",
    "      retries: 20",
    "      start_period: 10s",
    "    networks: [web]",
    "  converter:",
    `    image: ${yaml(images.converter)}`,
    "    environment:",
    "      DATABASE_PATH: /data/db/learning.sqlite",
    "      STORAGE_ROOT: /data/storage",
    "      MAX_UPLOAD_BYTES: \"26214400\"",
    "      CONVERTER_TIMEOUT_MS: \"120000\"",
    "      CONVERTER_MAX_PAGES: \"100\"",
    "      CONVERTER_MAX_OUTPUT_BYTES: \"26214400\"",
    "      CONVERTER_RENDER_DPI: \"120\"",
    "    volumes:",
    `      - ${yaml(`${db}:/data/db`)}`,
    `      - ${yaml(`${storage}:/data/storage`)}`,
    "    depends_on:",
    "      backend:",
    "        condition: service_healthy",
    "    healthcheck:",
    "      test: [\"CMD\", \"test\", \"-f\", \"/tmp/converter-ready\"]",
    "      interval: 5s",
    "      timeout: 3s",
    "      retries: 20",
    "      start_period: 30s",
    "    network_mode: none",
    "  email-worker:",
    `    image: ${yaml(images.emailWorker)}`,
    "    command: [\"npm\", \"run\", \"email-worker\"]",
    "    environment:",
    "      DATABASE_PATH: /data/db/learning.sqlite",
    "      EMAIL_ENABLED: \"false\"",
    "      EMAIL_FROM: python-learning@example.invalid",
    "      SMTP_HOST: \"\"",
    "      SMTP_PORT: \"1025\"",
    "      SMTP_TLS_MODE: none",
    `      AI_MASTER_KEY: ${yaml(aiKey)}`,
    "      EMAIL_WORKER_READY_FILE: /tmp/email-worker-ready",
    "    volumes:",
    `      - ${yaml(`${db}:/data/db`)}`,
    "    depends_on:",
    "      backend:",
    "        condition: service_healthy",
    "    healthcheck:",
    "      test: [\"CMD\", \"test\", \"-f\", \"/tmp/email-worker-ready\"]",
    "      interval: 5s",
    "      timeout: 3s",
    "      retries: 20",
    "      start_period: 20s",
    "    networks: [web]",
    "networks:",
    "  web:",
    "    driver: bridge",
    "  runner-internal:",
    "    driver: bridge",
    "    internal: true",
    "",
  ];
  return lines.join("\n");
}

async function waitForGateway(baseUrl) {
  let lastError = "gateway not ready";
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
      lastError = `health ${response.status}`;
    } catch (error) { lastError = error instanceof Error ? error.message : "health request failed"; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  throw new Error(`Gateway did not become healthy: ${lastError}`);
}

async function waitForAllServices(serviceNames) {
  let lastState = "services not ready";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    let ready = true;
    const states = [];
    for (const serviceName of serviceNames) {
      const container = `${composeProject}-${serviceName}-1`;
      try {
        const state = docker(["inspect", "--format", "{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}", container]);
        states.push(`${serviceName}:${state}`);
        if (state !== "running|healthy") ready = false;
      } catch {
        states.push(`${serviceName}:missing`);
        ready = false;
      }
    }
    lastState = states.join(",");
    if (ready) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  throw new Error(`Not all isolated deployment services became healthy: ${lastState}`);
}

async function createSnapshotBackup({ sourceDatabase, sourceStorage, sourceBackups }) {
  const db = openLocalDatabase(sourceDatabase);
  try {
    const admin = db.get("SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at LIMIT 1");
    if (!admin) throw new Error("No active administrator exists in the source snapshot");
    const backups = new BackupService(db, {
      databasePath: sourceDatabase,
      sourceStorageRoot: sourceStorage,
      backupRoot: sourceBackups,
      enabled: true,
    });
    const record = await backups.create({ id: admin.id, role: "admin" }, { trigger: "manual", scope: "full" });
    assert.equal(record.status, "verified");
    return record;
  } finally {
    db.close();
  }
}

function cookieOf(response) {
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

async function api(baseUrl, path, options = {}) {
  const headers = new Headers(options.headers);
  const method = options.method ?? "GET";
  if (options.cookie) headers.set("cookie", options.cookie);
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) headers.set("origin", baseUrl);
  const response = await fetch(`${baseUrl}/api/v1${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const bytes = new Uint8Array(await response.arrayBuffer());
  let data = null;
  if ((response.headers.get("content-type") ?? "").includes("application/json") && bytes.byteLength) data = JSON.parse(new TextDecoder().decode(bytes));
  const expected = options.expected ?? 200;
  const errorCode = data?.error?.code ? ` ${data.error.code}` : "";
  assert.equal(response.status, expected, `${options.method ?? "GET"} ${path} expected ${expected}, got ${response.status}${errorCode}`);
  return { response, bytes, data, cookie: cookieOf(response) };
}

async function login(baseUrl, username, password) {
  const result = await api(baseUrl, "/auth/login", { method: "POST", body: { username, password } });
  assert.ok(result.cookie, "login did not return a session cookie");
  return result.cookie;
}

async function firstLogin(baseUrl, username, initialPassword, readyPassword) {
  const initialCookie = await login(baseUrl, username, initialPassword);
  await api(baseUrl, "/courses", { cookie: initialCookie, expected: 428 });
  await api(baseUrl, "/auth/password", { method: "POST", cookie: initialCookie, body: { newPassword: readyPassword } });
  return login(baseUrl, username, readyPassword);
}

function sanitizedReport(report) {
  return [
    "Phase 11 restore + authenticated upload persistence smoke",
    `status=${report.status}`,
    `host=${report.host ?? "unknown"}`,
    `arch=${report.arch ?? "unknown"}`,
    `source_volume_snapshot=${report.sourceVolumeSnapshot === true}`,
    `live_backup_mutation=${report.liveBackupMutation === true}`,
    `source_backup_created=${report.sourceBackupCreated === true}`,
    `restore_result=${report.restoreResult ?? "not-run"}`,
    `migration_level=${report.migrationLevel ?? "unknown"}`,
    `service_health=${report.serviceHealth ?? "not-run"}`,
    `authenticated_role=${report.authenticatedRole ?? "not-run"}`,
    `upload_http=${report.uploadHttp ?? "not-run"}`,
    `uploaded_byte_count=${report.uploadedByteCount ?? "not-run"}`,
    `source_sha256=${report.sourceSha256 ?? "not-recorded"}`,
    `download_http=${report.downloadHttp ?? "not-run"}`,
    `download_sha256=${report.downloadSha256 ?? "not-recorded"}`,
    `hash_match=${report.hashMatch === true}`,
    `restart_performed=${report.restartPerformed === true}`,
    `post_restart_metadata=${report.postRestartMetadata === true}`,
    `post_restart_download=${report.postRestartDownload === true}`,
    `wrong_role_boundary=${report.wrongRoleBoundary === true}`,
    `storage_containment=${report.storageContainment === true}`,
    `cleanup=${report.cleanup === true}`,
    "secrets_logged=false",
    "fixture_payload_logged=false",
    report.error ? `error=${report.error}` : "error=none",
    "",
  ].join("\n");
}

const report = { status: "BLOCKED", sourceVolumeSnapshot: false, liveBackupMutation: false, sourceBackupCreated: false, restartPerformed: false, cleanup: false };
let root;
let composePath;
let composeStarted = false;
let composeArgs;

try {
  root = await mkdtemp(join(tmpdir(), "phase11-restore-upload-"));
  await Promise.all(["db", "storage", "exports", "backups", "source-db", "source-storage", "source-exports", "source-backups"].map((name) => mkdir(join(root, name), { recursive: true })));
  report.host = process.platform;
  report.arch = docker(["info", "--format", "{{.Architecture}}"]).replace(/^x86_64$/, "amd64");

  const images = Object.fromEntries(Object.entries(sourceServices).map(([name, container]) => [name, inspectImage(container)]));
  const sourceEnv = inspectEnv(sourceServices.backend);
  const runnerEnv = inspectEnv(sourceServices.runner);
  sourceEnv.PYTHON_RUNNER_TOKEN ??= runnerEnv.RUNNER_SERVICE_TOKEN;

  const sourceDatabase = join(root, "source-db", "learning.sqlite");
  const sourceStorage = join(root, "source-storage");
  const sourceExports = join(root, "source-exports");
  const sourceBackups = join(root, "source-backups");
  docker([
    "run", "--rm", "--volumes-from", `${sourceServices.backend}:ro`,
    "-v", `${bindPath(join(root, "source-db"))}:/snapshot/db`,
    "-v", `${bindPath(sourceStorage)}:/snapshot/storage`,
    "-v", `${bindPath(sourceExports)}:/snapshot/exports`,
    images.backend,
    "node", "-e", "require('node:fs').cpSync('/data/db', '/snapshot/db', { recursive: true, force: true }); require('node:fs').cpSync('/data/storage', '/snapshot/storage', { recursive: true, force: true }); require('node:fs').cpSync('/data/exports', '/snapshot/exports', { recursive: true, force: true });",
  ], { cwd: workspace });
  report.sourceVolumeSnapshot = true;
  report.liveBackupMutation = false;
  const backup = await createSnapshotBackup({ sourceDatabase, sourceStorage, sourceBackups });
  assert.ok(typeof backup.id === "string" && backup.id.length > 10, "source backup did not return an id");
  report.sourceBackupCreated = true;

  const restoredRoot = join(root, "restore");
  const restoreOutput = execFileSync(process.execPath, ["--experimental-strip-types", "scripts/restore-isolated.mjs", backup.id, restoredRoot], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "development",
      DATABASE_PATH: sourceDatabase,
      STORAGE_ROOT: sourceStorage,
      EXPORT_STORAGE_ROOT: sourceExports,
      BACKUP_ROOT: sourceBackups,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  parseJsonOutput(restoreOutput);
  report.restoreResult = "pass";

  const restoredDatabase = join(restoredRoot, "database.sqlite");
  await stat(restoredDatabase);
  const restoredDb = openLocalDatabase(restoredDatabase);
  try {
    const integrity = assertDatabaseIntegrity(restoredDb);
    assert.equal(integrity.integrity, "ok");
    assert.equal(integrity.foreignKeys, 1);
    report.migrationLevel = restoredDb.get("SELECT name FROM app_migrations ORDER BY name DESC LIMIT 1")?.name ?? "unknown";
  } finally { restoredDb.close(); }

  const provisionOutput = execFileSync(process.execPath, ["--experimental-strip-types", "scripts/provision-local-admin-backend.mjs"], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, DATABASE_PATH: restoredDatabase, STORAGE_ROOT: join(root, "storage"), BACKUP_ROOT: join(root, "backups"), LOCAL_ADMIN_ACTION: "rotate" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const provisioned = parseJsonOutput(provisionOutput);
  assert.equal(provisioned.username, "admin-local");
  assert.equal(provisioned.mustChangePassword, true);
  const initialPassword = provisioned.initialPassword;
  const readyPassword = `Restore-${stamp}-Admin!`;
  await copyFile(restoredDatabase, join(root, "db", "learning.sqlite"));
  for (const directory of ["assets", "previews"]) {
    try { await cp(join(restoredRoot, directory), join(root, "storage", directory), { recursive: true, force: true }); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }

  const port = Number(process.env.SMOKE_PORT ?? await freePort());
  composePath = join(root, "compose.yml");
  await writeFile(composePath, composeFile({ root, port, images, sourceEnv }), { mode: 0o600 });
  composeArgs = ["compose", "-p", composeProject, "-f", composePath];
  docker([...composeArgs, "config", "--quiet"]);
  composeStarted = true;
  docker([...composeArgs, "up", "-d", "--no-build"]);

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForAllServices(["runner", "backend", "web", "gateway", "converter", "email-worker"]);
  await waitForGateway(baseUrl);
  report.serviceHealth = "runner/backend/web/gateway/converter/email-worker healthy";

  const adminCookie = await firstLogin(baseUrl, "admin-local", initialPassword, readyPassword);
  const me = await api(baseUrl, "/me", { cookie: adminCookie });
  assert.equal(me.data?.user?.role, "admin");
  await api(baseUrl, "/admin/dashboard", { cookie: adminCookie }).catch(() => null);
  report.authenticatedRole = "admin";

  const studentUsername = `c2c-student-${stamp}`;
  const createdStudent = await api(baseUrl, "/admin/users", { method: "POST", cookie: adminCookie, body: { role: "student", username: studentUsername, chineseName: "隔離 smoke 學生", studentNumber: `C2C-${stamp}` }, expected: 201 });
  const studentInitial = createdStudent.data?.user?.initialPassword ?? createdStudent.data?.initialPassword;
  assert.equal(typeof studentInitial, "string");
  const studentCookie = await firstLogin(baseUrl, studentUsername, studentInitial, `Restore-${stamp}-Student!`);

  const fixture = new TextEncoder().encode(`phase11-restore-upload-smoke:${stamp}\n`);
  const sourceHash = sha256(fixture);
  report.sourceSha256 = sourceHash;
  report.uploadedByteCount = fixture.byteLength;
  const uploaded = await api(baseUrl, "/files", { method: "POST", cookie: adminCookie, body: { originalName: `phase11-${stamp}.txt`, mimeType: "text/plain", contentBase64: Buffer.from(fixture).toString("base64"), purpose: "material_library", libraryScope: "private" }, expected: 201 });
  const assetId = uploaded.data?.asset?.id;
  assert.ok(assetId, "upload did not return an asset id");
  report.uploadHttp = 201;
  const released = await api(baseUrl, `/files/${encodeURIComponent(assetId)}/release`, { method: "POST", cookie: adminCookie });
  assert.equal(released.data?.asset?.status, "ready");
  const listed = await api(baseUrl, "/files?scope=available", { cookie: adminCookie });
  assert.ok(listed.data?.assets?.some((asset) => asset.id === assetId && asset.status === "ready"));
  const downloaded = await api(baseUrl, `/files/${encodeURIComponent(assetId)}/download`, { cookie: adminCookie });
  assert.equal(downloaded.response.status, 200);
  const downloadHash = sha256(downloaded.bytes);
  report.downloadHttp = downloaded.response.status;
  report.downloadSha256 = downloadHash;
  report.hashMatch = downloadHash === sourceHash;
  assert.equal(report.hashMatch, true);

  const assetPath = resolve(root, "storage", "assets", `${assetId}.bin`);
  const storageRelative = relative(resolve(root, "storage"), assetPath);
  assert.ok(storageRelative && !storageRelative.startsWith("..") && !storageRelative.includes(":") && await stat(assetPath));
  report.storageContainment = true;
  const wrongRole = await api(baseUrl, `/files/${encodeURIComponent(assetId)}/download`, { cookie: studentCookie, expected: 403 });
  report.wrongRoleBoundary = wrongRole.response.status === 403;

  docker([...composeArgs, "restart", "runner", "backend", "web", "gateway", "converter", "email-worker"]);
  report.restartPerformed = true;
  await waitForAllServices(["runner", "backend", "web", "gateway", "converter", "email-worker"]);
  await waitForGateway(baseUrl);
  const adminAfterRestart = await login(baseUrl, "admin-local", readyPassword);
  const postList = await api(baseUrl, "/files?scope=available", { cookie: adminAfterRestart });
  report.postRestartMetadata = postList.data?.assets?.some((asset) => asset.id === assetId && asset.status === "ready");
  assert.equal(report.postRestartMetadata, true);
  const postDownload = await api(baseUrl, `/files/${encodeURIComponent(assetId)}/download`, { cookie: adminAfterRestart });
  report.postRestartDownload = sha256(postDownload.bytes) === sourceHash;
  assert.equal(report.postRestartDownload, true);
  report.status = "PASS";
} catch (error) {
  report.status = error?.code === "docker_command_failed" ? "BLOCKED" : "FAIL";
  report.error = error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 240) : "unknown failure";
} finally {
  let cleanupOk = true;
  if (composeStarted && composeArgs) {
    try { docker([...composeArgs, "down", "--remove-orphans"], { timeout: 120000 }); } catch { cleanupOk = false; }
  }
  if (root) {
    try { await rm(root, { recursive: true, force: true }); } catch { cleanupOk = false; }
  }
  report.cleanup = cleanupOk;
  await writeFile(evidencePath, sanitizedReport(report) + "\n", { mode: 0o600 });
}

console.log(sanitizedReport(report));
if (report.status !== "PASS") process.exitCode = 1;
