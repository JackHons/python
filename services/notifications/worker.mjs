import { writeFile, unlink } from "node:fs/promises";
import { openLocalDatabase } from "../../server/db.ts";
import { NotificationService } from "../../server/notifications/service.ts";
import { SmtpMailer } from "../../server/notifications/smtp.ts";
import { MasterKeyCipher } from "../../server/ai.ts";

const db = openLocalDatabase(process.env.DATABASE_PATH ?? "/data/db/learning.sqlite");
const mailer = new SmtpMailer(process.env.SMTP_HOST ? {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 1025),
  tlsMode: process.env.SMTP_TLS_MODE === "tls" || process.env.SMTP_TLS_MODE === "starttls" ? process.env.SMTP_TLS_MODE : "none",
  username: process.env.SMTP_USERNAME || undefined,
  password: process.env.SMTP_PASSWORD || undefined,
  from: process.env.EMAIL_FROM ?? "python-learning@example.invalid",
} : undefined);
const cipher = process.env.AI_MASTER_KEY ? new MasterKeyCipher(process.env.AI_MASTER_KEY) : null;
const notifications = new NotificationService(db, undefined, { mailer, emailEnabled: process.env.EMAIL_ENABLED === "true", secretCipher: cipher });
const intervalMs = Math.max(1000, Number(process.env.EMAIL_WORKER_INTERVAL_MS ?? 10000));
const readyFile = process.env.EMAIL_WORKER_READY_FILE ?? "/tmp/email-worker-ready";
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
await writeFile(readyFile, "ready\n", { mode: 0o600 });

async function sendDueReminders() {
  const now = new Date();
  const until = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
  const rows = db.all("SELECT a.id, c.owner_teacher_id FROM assignments a JOIN courses c ON c.id = a.course_id WHERE a.status = 'published' AND a.due_at IS NOT NULL AND a.due_at > ? AND a.due_at <= ?", [now.toISOString(), until]);
  for (const row of rows) {
    try { notifications.notifyDueReminder({ id: String(row.owner_teacher_id), role: "teacher" }, String(row.id), `assignment:${row.id}:due-reminder:${String(row.id)}:${until.slice(0, 10)}`); } catch { /* A scoped/archived course is safely ignored. */ }
  }
}

while (!stopping) {
  await sendDueReminders();
  await notifications.processEmailQueue({ limit: 50 });
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
await unlink(readyFile).catch(() => {});
db.close();
