import { writeFile, unlink } from "node:fs/promises";
import { openLocalDatabase } from "../../server/db.ts";
import { LocalFileStorage } from "../../server/storage.ts";
import { MaterialConversionService } from "../../server/conversion/service.ts";

const readyFile = process.env.CONVERTER_READY_FILE ?? "/tmp/converter-ready";
const intervalMs = Math.max(250, Number(process.env.CONVERTER_POLL_MS ?? 1000));
const db = openLocalDatabase(process.env.DATABASE_PATH ?? "/data/db/learning.sqlite");
const storage = new LocalFileStorage(process.env.STORAGE_ROOT ?? "/data/storage", Number(process.env.MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024));
const converter = new MaterialConversionService(db, storage, {
  timeoutMs: Number(process.env.CONVERTER_TIMEOUT_MS ?? 120000),
  maxPages: Number(process.env.CONVERTER_MAX_PAGES ?? 100),
  maxOutputBytes: Number(process.env.CONVERTER_MAX_OUTPUT_BYTES ?? 25 * 1024 * 1024),
  renderDpi: Number(process.env.CONVERTER_RENDER_DPI ?? 120),
});

let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
await writeFile(readyFile, "ready\n", { mode: 0o600 });

while (!stopping) {
  try {
    const result = await converter.processOne();
    if (!result) await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } catch {
    // Job-specific failures are persisted in a sanitized form by the service.
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

await unlink(readyFile).catch(() => {});
db.close();
