import { createBackendApp } from "../server/http/backend.ts";
import { mkdir, chmod, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

if (process.env.NODE_ENV === "production") throw new Error("Demo seed is disabled in production");
const credentialsFile = process.env.SEED_CREDENTIALS_FILE;
if (!credentialsFile) throw new Error("SEED_CREDENTIALS_FILE is required; credentials are never printed or logged");
const credentialsPath = resolve(credentialsFile);
const app = createBackendApp({ databasePath: process.env.DATABASE_PATH ?? "./var/db/learning.sqlite" });
try {
  const existing = app.services.db.get("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (existing) {
    console.log(JSON.stringify({ seeded: false, credentialsWritten: false, note: "An administrator already exists; no credentials were generated." }));
  } else {
    const result = app.services.education.createInitialAdmin({ username: "admin-demo", chineseName: "示範管理員" });
    await mkdir(dirname(credentialsPath), { recursive: true });
    await writeFile(credentialsPath, JSON.stringify({ username: result.user.username, initialPassword: result.initialPassword, mustChangePassword: true }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await chmod(credentialsPath, 0o600);
    console.log(JSON.stringify({ seeded: true, credentialsWritten: true, credentialsFile: credentialsPath, note: "Read this one-time file manually, then remove it using your approved local procedure." }));
  }
} finally { app.close(); }
