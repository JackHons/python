import { randomBytes } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";

const path = new URL("../.env", import.meta.url);
const token = () => randomBytes(32).toString("base64url");
const contents = [
  "BACKEND_INTERNAL_TOKEN=" + token(),
  "RUNNER_SERVICE_TOKEN=" + token(),
  "AI_MASTER_KEY=" + randomBytes(32).toString("base64"),
  "SESSION_COOKIE_SECURE=false",
  "ALLOW_LEGACY_RUN=false",
  "NEXT_PUBLIC_DEMO_MODE=false",
  "WEB_PORT=3000",
  "BACKUP_ENABLED=false",
  "BACKUP_RETENTION_DAYS=30",
  "EMAIL_ENABLED=false",
  "EMAIL_FROM=python-learning@example.invalid",
].join("\n") + "\n";
await writeFile(path, contents, { flag: "wx", mode: 0o600 });
await chmod(path, 0o600);
console.log("Created .env with local random secrets (values intentionally not displayed).");
