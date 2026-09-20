import { createBackendServer } from "./backend.ts";

const { server } = createBackendServer({
  databasePath: process.env.DATABASE_PATH,
  storageRoot: process.env.STORAGE_ROOT,
  exportRoot: process.env.EXPORT_STORAGE_ROOT,
  backupRoot: process.env.BACKUP_ROOT,
  internalToken: process.env.BACKEND_INTERNAL_TOKEN,
  production: process.env.NODE_ENV === "production",
});
const port = Number(process.env.BACKEND_PORT ?? 8787);
server.listen(port, process.env.BACKEND_HOST ?? "127.0.0.1", () => {
  process.stdout.write("backend listening on " + port + "\n");
});
process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
