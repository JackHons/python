import { createBackendApp } from "../server/http/backend.ts";

if (process.env.BACKUP_ENABLED !== "true") throw new Error("Set BACKUP_ENABLED=true before a manual host backup");
const app = createBackendApp({ databasePath: process.env.DATABASE_PATH, storageRoot: process.env.STORAGE_ROOT, exportRoot: process.env.EXPORT_STORAGE_ROOT, backupRoot: process.env.BACKUP_ROOT });
try {
  const admin = app.services.db.get("SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at LIMIT 1");
  if (!admin) throw new Error("No active administrator exists");
  const result = await app.services.backups.create({ id: admin.id, role: "admin" }, { trigger: "manual", scope: "full" });
  console.log(JSON.stringify({ id: result.id, status: result.status, checksum: result.checksum }));
} finally { app.close(); }
