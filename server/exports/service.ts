/* eslint-disable @typescript-eslint/no-explicit-any -- export rows are report projections. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import * as XLSX from "xlsx";
import type { Actor } from "../education.ts";
import type { LocalDatabase } from "../db.ts";
import { DomainError } from "../errors.ts";
import { AuditService } from "../audit/service.ts";
import { AnalyticsService } from "../analytics/service.ts";

const REPORT_VERSION = "v1";
const TIMEZONE = "Asia/Macau";
const CONTENT_TYPES: Record<string, string> = { xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pdf: "application/pdf", csv: "text/csv; charset=utf-8" };
type Format = "xlsx" | "pdf" | "csv";
type ReportType = "overview" | "questionAccuracy" | "commonErrors" | "aiUsage" | "codeHistory" | "learningTime" | "compareCourses";
type Filters = { courseId?: string; classId?: string; studentId?: string };

function now(clock: () => Date) { return clock().toISOString(); }
function json(value: unknown) { return JSON.stringify(value ?? {}); }
function requireRow<T>(row: T | undefined, message: string) { if (!row) throw new DomainError("not_found", message, 404); return row; }
function safeFilePart(value: string) { return value.replace(/[^A-Za-z0-9._-]/g, "_"); }
function safeCell(value: unknown) {
  if (typeof value !== "string") return value;
  const cleaned = value.replace(/[\t\r\n]/g, " ");
  return /^[=+\-@]/.test(cleaned) ? `'${cleaned}` : cleaned;
}
function flattenRows(data: Record<string, unknown>) {
  const rows: Array<Record<string, unknown>> = [];
  for (const [section, value] of Object.entries(data)) {
    if (Array.isArray(value)) for (const item of value) rows.push({ section, ...(item && typeof item === "object" ? item as Record<string, unknown> : { value }) });
    else rows.push({ section, value });
  }
  return rows;
}
function csv(bytes: Array<Record<string, unknown>>) {
  const keys = [...new Set(bytes.flatMap((row) => Object.keys(row)))];
  const quote = (value: unknown) => `"${String(safeCell(value) ?? "").replace(/"/g, '""')}"`;
  return new TextEncoder().encode([keys.map(quote).join(","), ...bytes.map((row) => keys.map((key) => quote(row[key])).join(","))].join("\r\n") + "\r\n");
}

function pdfEscape(value: string) { return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/[^\x20-\x7E]/g, "?"); }
function makePdf(lines: string[]) {
  const content = ["BT", "/F1 10 Tf", "40 800 Td", ...lines.flatMap((line, index) => [`(${pdfEscape(line).slice(0, 180)}) Tj`, ...(index < lines.length - 1 ? ["0 -16 Td"] : [])]), "ET"].join("\n");
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets[index + 1] = Buffer.byteLength(output); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => String(offset).padStart(10, "0") + " 00000 n ").join("\n")}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(output);
}

export class ExportService {
  private readonly db: LocalDatabase;
  private readonly analytics: AnalyticsService;
  private readonly audit: AuditService;
  private readonly root: string;
  private readonly clock: () => Date;
  private readonly retentionDays: number;
  constructor(db: LocalDatabase, root: string, clock: () => Date = () => new Date(), options: { retentionDays?: number } = {}) {
    this.db = db; this.analytics = new AnalyticsService(db, clock); this.audit = new AuditService(db); this.root = resolve(root); this.clock = clock; this.retentionDays = Math.max(1, options.retentionDays ?? 7);
  }

  private report(actor: Actor, type: ReportType, filters: Filters) {
    const map: Record<ReportType, (actor: Actor, filters: Filters) => any> = { overview: (a, f) => this.analytics.overview(a, f), questionAccuracy: (a, f) => this.analytics.questionAccuracy(a, f), commonErrors: (a, f) => this.analytics.commonErrors(a, f), aiUsage: (a, f) => this.analytics.aiUsage(a, f), codeHistory: (a, f) => this.analytics.codeHistory(a, f), learningTime: (a, f) => this.analytics.learningTime(a, f), compareCourses: (a, f) => this.analytics.compareCourses(a, f) };
    return map[type]?.(actor, filters) ?? (() => { throw new DomainError("invalid_report", "Report type is not supported"); })();
  }

  createJob(actor: Actor, input: { reportType: ReportType; format: Format; filters?: Filters; correlationId?: string }) {
    if (!Object.keys(CONTENT_TYPES).includes(input.format)) throw new DomainError("invalid_format", "Export format is not supported");
    const filters = input.filters ?? {};
    const report = this.report(actor, input.reportType, filters);
    const id = randomUUID();
    const correlationId = input.correlationId ?? randomUUID();
    const snapshotAt = report.snapshotAt;
    this.db.run("INSERT INTO export_jobs (id, requested_by_id, report_type, format, scope_json, filter_json, snapshot_at, data_snapshot_json, missing_data_json, timezone, report_version, status, correlation_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)", [id, actor.id, input.reportType, input.format, json(report.scope), json(filters), snapshotAt, json(report.data), json(report.missingData), TIMEZONE, REPORT_VERSION, correlationId, new Date(this.clock().getTime() + this.retentionDays * 86400000).toISOString()]);
    this.audit.record(actor, { action: "export.job_created", entityType: "export_job", entityId: id, correlationId, metadata: { reportType: input.reportType, format: input.format, scope: report.scope } });
    return this.db.get("SELECT * FROM export_jobs WHERE id = ?", [id]);
  }

  async runJob(actor: Actor, jobId: string) {
    const job = requireRow<Record<string, any>>(this.db.get("SELECT * FROM export_jobs WHERE id = ?", [jobId]), "Export job not found");
    if (job.requested_by_id !== actor.id && actor.role !== "admin") throw new DomainError("forbidden", "You cannot run this export", 403);
    if (job.status === "completed") return this.db.get("SELECT * FROM export_jobs WHERE id = ?", [jobId]);
    const filters = JSON.parse(job.filter_json) as Filters;
    this.db.run("UPDATE export_jobs SET status = 'running', attempt_count = attempt_count + 1, started_at = ?, error_code = NULL, error_message = NULL WHERE id = ?", [now(this.clock), jobId]);
    try {
      const report = { snapshotAt: job.snapshot_at, timezone: job.timezone, reportVersion: job.report_version, scope: JSON.parse(job.scope_json), data: JSON.parse(job.data_snapshot_json), missingData: JSON.parse(job.missing_data_json) };
      const rows = flattenRows(report.data).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, safeCell(value)])));
      let bytes: Uint8Array;
      if (job.format === "xlsx") {
        const workbook = XLSX.utils.book_new();
        const metadata = [["reportVersion", REPORT_VERSION], ["snapshotAt", job.snapshot_at], ["timezone", TIMEZONE], ["scope", json(report.scope)], ["filters", json(filters)]];
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(metadata), "_metadata");
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "data");
        bytes = new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
      } else if (job.format === "csv") {
        bytes = csv(rows);
      } else {
        bytes = makePdf([`Learning Platform Report ${REPORT_VERSION}`, `SnapshotAt: ${job.snapshot_at}`, `Timezone: ${TIMEZONE}`, `Scope: ${json(report.scope)}`, `Filters: ${json(filters)}`, ...rows.slice(0, 45).map((row) => Object.entries(row).map(([key, value]) => `${key}=${String(value)}`).join(" | "))]);
      }
      const key = `exports/${job.id}.${job.format}`;
      const path = resolve(this.root, key);
      if (!path.startsWith(`${this.root}/`)) throw new DomainError("invalid_storage_key", "Export storage key is invalid");
      await mkdir(resolve(this.root, "exports"), { recursive: true });
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 }).catch(async (error) => { if (error.code === "EEXIST") await writeFile(path, bytes, { mode: 0o600 }); else throw error; });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      this.db.run("UPDATE export_jobs SET status = 'completed', storage_key = ?, sha256 = ?, byte_size = ?, finished_at = ? WHERE id = ?", [key, sha256, bytes.byteLength, now(this.clock), jobId]);
      this.audit.record(actor, { action: "export.job_completed", entityType: "export_job", entityId: jobId, correlationId: job.correlation_id, metadata: { sha256, byteSize: bytes.byteLength, format: job.format } });
    } catch (error) {
      const code = error instanceof DomainError ? error.code : "export_failed";
      this.db.run("UPDATE export_jobs SET status = 'failed', error_code = ?, error_message = ?, finished_at = ? WHERE id = ?", [code, error instanceof Error ? error.message.slice(0, 200) : "Export failed", now(this.clock), jobId]);
      this.audit.record(actor, { action: "export.job_failed", entityType: "export_job", entityId: jobId, result: "failure", correlationId: job.correlation_id, metadata: { errorCode: code } });
      throw error;
    }
    return this.db.get("SELECT * FROM export_jobs WHERE id = ?", [jobId]);
  }
  processJob(actor: Actor, jobId: string) { return this.runJob(actor, jobId); }
  run(actor: Actor, jobId: string) { return this.runJob(actor, jobId); }

  async download(actor: Actor, jobId: string) {
    const job = requireRow<Record<string, any>>(this.db.get("SELECT * FROM export_jobs WHERE id = ?", [jobId]), "Export job not found");
    if (job.requested_by_id !== actor.id && actor.role !== "admin") throw new DomainError("forbidden", "You cannot download this export", 403);
    if (job.status !== "completed" || !job.storage_key) throw new DomainError("export_unavailable", "Export is not ready");
    if (job.expires_at && new Date(job.expires_at).getTime() <= this.clock().getTime()) throw new DomainError("export_expired", "Export has expired", 410);
    const path = resolve(this.root, job.storage_key);
    if (relative(this.root, path).startsWith("..")) throw new DomainError("invalid_storage_key", "Export storage key is invalid");
    const bytes = await readFile(path);
    if (createHash("sha256").update(bytes).digest("hex") !== job.sha256) throw new DomainError("export_checksum_mismatch", "Export checksum mismatch", 500);
    return { bytes, contentType: CONTENT_TYPES[job.format], fileName: `learning-report-${safeFilePart(job.report_type)}.${job.format}`, snapshotAt: job.snapshot_at, timezone: job.timezone, reportVersion: job.report_version, sha256: job.sha256 };
  }

  listJobs(actor: Actor) {
    if (actor.role === "admin") return this.db.all("SELECT * FROM export_jobs ORDER BY created_at DESC");
    return this.db.all("SELECT * FROM export_jobs WHERE requested_by_id = ? ORDER BY created_at DESC", [actor.id]);
  }
  retryJob(actor: Actor, jobId: string) {
    const job = requireRow<{ requested_by_id: string; status: string }>(this.db.get("SELECT requested_by_id, status FROM export_jobs WHERE id = ?", [jobId]), "Export job not found");
    if (job.requested_by_id !== actor.id && actor.role !== "admin") throw new DomainError("forbidden", "You cannot retry this export", 403);
    if (job.status !== "failed") throw new DomainError("invalid_export_state", "Only failed exports can be retried");
    this.db.run("UPDATE export_jobs SET status = 'queued', error_code = NULL, error_message = NULL WHERE id = ?", [jobId]);
    return this.db.get("SELECT * FROM export_jobs WHERE id = ?", [jobId]);
  }
  async cleanupExpired(actor: Actor) {
    if (actor.role !== "admin") throw new DomainError("forbidden", "Administrator permission required", 403);
    const rows = this.db.all<{ id: string; storage_key: string | null }>("SELECT id, storage_key FROM export_jobs WHERE expires_at IS NOT NULL AND expires_at <= ? AND status = 'completed'", [now(this.clock)]);
    for (const row of rows) if (row.storage_key) await unlink(resolve(this.root, row.storage_key)).catch(() => undefined);
    this.db.run("UPDATE export_jobs SET status = 'cancelled', storage_key = NULL, deleted_at = NULL WHERE expires_at IS NOT NULL AND expires_at <= ? AND status = 'completed'", [now(this.clock)]);
    this.audit.record(actor, { action: "export.cleanup", entityType: "export_job", metadata: { count: rows.length } });
    return { deleted: rows.length };
  }
}
