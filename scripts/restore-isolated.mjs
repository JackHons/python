import { createBackendApp } from "../server/http/backend.ts";

const [backupId, targetDirectory] = process.argv.slice(2);
if (!backupId || !targetDirectory) throw new Error("usage: restore-isolated.mjs BACKUP_ID EMPTY_TARGET_DIRECTORY");
const app = createBackendApp({ databasePath: process.env.DATABASE_PATH, storageRoot: process.env.STORAGE_ROOT, exportRoot: process.env.EXPORT_STORAGE_ROOT, backupRoot: process.env.BACKUP_ROOT });
try {
  const admin = app.services.db.get("SELECT id FROM users WHERE role = 'admin' AND status = 'active' ORDER BY created_at LIMIT 1");
  if (!admin) throw new Error("No active administrator exists");
  const result = await app.services.backups.restore({ id: admin.id, role: "admin" }, backupId, targetDirectory);
  console.log(JSON.stringify({ backupId: result.backupId, targetDirectory: result.targetDirectory, integrity: result.integrity }));
} finally { app.close(); }
