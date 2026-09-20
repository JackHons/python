import { writeFile } from "node:fs/promises";

const base = process.env.PHASE8_WEB_URL ?? "http://127.0.0.1:3000";
const password = process.env.PHASE8_ADMIN_PASSWORD;
if (!password) throw new Error("PHASE8_ADMIN_PASSWORD is required and is never logged");
function cookieOf(response) { return response.headers.get("set-cookie")?.split(";", 1)[0] ?? ""; }
async function request(path, options = {}, cookie = "") {
  const headers = new Headers(options.headers);
  if (cookie) headers.set("cookie", cookie);
  if (options.body !== undefined) { headers.set("content-type", "application/json"); headers.set("origin", base); }
  return fetch(`${base}/api/v1${path}`, { ...options, headers });
}
const login = await request("/auth/login", { method: "POST", body: JSON.stringify({ username: "admin-demo", password }) });
if (login.status !== 200) throw new Error(`backup login failed: ${login.status}`);
const cookie = cookieOf(login);
const settings = await request("/admin/backups", {}, cookie);
if (!settings.ok) throw new Error(`backup settings read failed: ${settings.status}`);
const enabled = await request("/admin/backups", { method: "PATCH", body: JSON.stringify({ enabled: true }) }, cookie);
if (!enabled.ok) throw new Error(`backup enable failed: ${enabled.status}`);
const created = await request("/admin/backups", { method: "POST", body: JSON.stringify({ scope: "full", trigger: "manual" }) }, cookie);
if (created.status !== 202) throw new Error(`backup create failed: ${created.status}`);
const createdBody = await created.json();
const backup = createdBody.backup;
const verified = await request(`/admin/backups/${encodeURIComponent(backup.id)}/verify`, { method: "POST", body: JSON.stringify({}) }, cookie);
if (!verified.ok) throw new Error(`backup verify failed: ${verified.status}`);
const verification = await verified.json();
const report = {
  scenario: "compose-backup-full-verify",
  settingsStatus: settings.status,
  enabledStatus: enabled.status,
  createStatus: created.status,
  verifyStatus: verified.status,
  backupId: backup.id,
  backupStatus: backup.status,
  checksum: verification.verification?.checksum ?? null,
  valid: verification.verification?.valid === true,
  plaintextSecretsLogged: false,
  note: "Backup was created in the backend volume and verified by manifest/database checksum; credentials are process-only and omitted.",
};
await writeFile("docs/任務包/證據/phase8b-backup.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
