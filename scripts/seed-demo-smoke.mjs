import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = await mkdtemp(join(tmpdir(), "python-seed-smoke-"));
const seed = new URL("./seed-demo.mjs", import.meta.url);
function run(database, credentials, extra = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", decodeURIComponent(seed.pathname)], { env: { ...process.env, NODE_ENV: "development", DATABASE_PATH: database, SEED_CREDENTIALS_FILE: credentials, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
try {
  const database = join(root, "first.sqlite");
  const credentials = join(root, "credentials.json");
  const first = await run(database, credentials);
  if (first.code !== 0) throw new Error(`first seed failed: ${first.stderr || first.stdout}`);
  const saved = JSON.parse(await readFile(credentials, "utf8"));
  const mode = (await stat(credentials)).mode & 0o777;
  if (first.code !== 0 || mode !== 0o600 || saved.mustChangePassword !== true || !saved.initialPassword) throw new Error("seed credential contract failed");
  const second = await run(join(root, "second.sqlite"), credentials);
  const production = await run(join(root, "production.sqlite"), join(root, "production-credentials.json"), { NODE_ENV: "production" });
  if (second.code === 0 || !second.stderr.includes("EEXIST")) throw new Error("credential overwrite was not rejected");
  if (production.code === 0 || !production.stderr.includes("disabled in production")) throw new Error("production seed was not disabled");
  console.log(JSON.stringify({ firstSeed: "ok", mode: "0600", overwrite: "rejected", production: "disabled" }));
} finally {
  await rm(root, { recursive: true, force: true });
}
