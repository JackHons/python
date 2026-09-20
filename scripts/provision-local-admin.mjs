import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);
const action = process.argv.includes("--rotate") ? "rotate" : "provision";
if (process.env.LOCAL_ADMIN_CONFIRM !== "PROVISION_LOCAL_ADMIN") {
  throw new Error("Set LOCAL_ADMIN_CONFIRM=PROVISION_LOCAL_ADMIN; no credential was changed");
}
const root = resolve(process.cwd(), ".local-secrets");
const destination = resolve(root, "admin.json");
const temporary = resolve(root, `admin.json.tmp-${process.pid}`);
await mkdir(root, { recursive: true, mode: 0o700 });
await chmod(root, 0o700);
if (action === "provision") {
  try { await stat(destination); throw new Error(".local-secrets/admin.json already exists; use --rotate"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
}
try {
  const handle = await open(temporary, "wx", 0o600);
  try {
    const result = await execFileAsync("docker", ["compose", "exec", "-T", "-e", "NODE_NO_WARNINGS=1", "-e", `LOCAL_ADMIN_ACTION=${action}`, "backend", "node", "--experimental-strip-types", "scripts/provision-local-admin-backend.mjs"], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    const value = JSON.parse(result.stdout);
    if (value.username !== "admin-local" || typeof value.initialPassword !== "string" || value.initialPassword.length < 8 || value.mustChangePassword !== true) throw new Error("backend returned an invalid credential contract");
    await handle.writeFile(JSON.stringify({ username: value.username, initialPassword: value.initialPassword, mustChangePassword: true }, null, 2) + "\n", "utf8");
  } finally {
    await handle.chmod(0o600);
    await handle.close();
  }
  await chmod(temporary, 0o600);
  await rename(temporary, destination);
  console.log(JSON.stringify({ action, credentialsFile: ".local-secrets/admin.json", mode: "0600", fixtureAccountsArchived: true, secretPrinted: false }));
} catch (error) {
  await rm(temporary, { force: true });
  throw new Error(`local admin ${action} failed: ${error instanceof Error ? error.message : "unknown error"}`);
}
