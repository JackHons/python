import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { LocalDatabase } from "../db.ts";
import { LocalFileStorage } from "../storage.ts";

type ConversionRow = {
  id: string;
  material_id: string;
  source_asset_id: string;
  storage_key: string;
  original_name: string;
  uploaded_by_id: string;
};

export type ConversionLimits = {
  timeoutMs?: number;
  maxPages?: number;
  maxOutputBytes?: number;
  renderDpi?: number;
  sofficePath?: string;
  pdfInfoPath?: string;
  pdfToPpmPath?: string;
};

function safeMessage(value: unknown) {
  return String(value instanceof Error ? value.message : value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/(?:\/[^ ]+)+/g, "[path]")
    .slice(0, 300);
}

async function run(command: string, args: string[], cwd: string, timeoutMs: number) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, TMPDIR: cwd, LANG: "C.UTF-8", NODE_ENV: process.env.NODE_ENV ?? "production" },
    });
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: Buffer) => (current + chunk.toString("utf8")).slice(-16_384);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("conversion_timeout"));
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`conversion_command_failed:${code}:${safeMessage(stderr)}`));
    });
  });
}

export class MaterialConversionService {
  private readonly db: LocalDatabase;
  private readonly storage: LocalFileStorage;
  private readonly timeoutMs: number;
  private readonly maxPages: number;
  private readonly maxOutputBytes: number;
  private readonly renderDpi: number;
  private readonly sofficePath: string;
  private readonly pdfInfoPath: string;
  private readonly pdfToPpmPath: string;

  constructor(db: LocalDatabase, storage: LocalFileStorage, limits: ConversionLimits = {}) {
    this.db = db;
    this.storage = storage;
    this.timeoutMs = limits.timeoutMs ?? 120_000;
    this.maxPages = limits.maxPages ?? 100;
    this.maxOutputBytes = Math.min(limits.maxOutputBytes ?? 25 * 1024 * 1024, storage.maxBytes);
    this.renderDpi = limits.renderDpi ?? 120;
    this.sofficePath = limits.sofficePath ?? process.env.SOFFICE_PATH ?? "soffice";
    this.pdfInfoPath = limits.pdfInfoPath ?? process.env.PDFINFO_PATH ?? "pdfinfo";
    this.pdfToPpmPath = limits.pdfToPpmPath ?? process.env.PDFTOPPM_PATH ?? "pdftoppm";
  }

  private claim(): ConversionRow | null {
    return this.db.transaction(() => {
      const row = this.db.get<ConversionRow>(`SELECT j.id, j.material_id, j.source_asset_id,
        f.storage_key, f.original_name, m.created_by_id AS uploaded_by_id
        FROM material_conversion_jobs j
        JOIN file_assets f ON f.id = j.source_asset_id
        JOIN materials m ON m.id = j.material_id
        WHERE j.status = 'queued' ORDER BY j.created_at, j.id LIMIT 1`);
      if (!row) return null;
      const result = this.db.run("UPDATE material_conversion_jobs SET status = 'running', started_at = CURRENT_TIMESTAMP, error_code = NULL, error_message = NULL WHERE id = ? AND status = 'queued'", [row.id]);
      return Number(result.changes) === 1 ? row : null;
    });
  }

  async processOne() {
    const job = this.claim();
    if (!job) return null;
    const work = await mkdtemp(join(tmpdir(), "material-conversion-"));
    let outputAssetId: string | null = null;
    try {
      const extension = extname(job.original_name).toLowerCase();
      if (![".ppt", ".pptx", ".doc", ".docx", ".pdf"].includes(extension)) throw new Error("unsupported_conversion_source");
      const sourcePath = join(work, `source${extension}`);
      await writeFile(sourcePath, await this.storage.read(job.storage_key), { flag: "wx", mode: 0o600 });
      let pdfPath = sourcePath;
      if (extension !== ".pdf") {
        await run(this.sofficePath, ["--headless", "--convert-to", "pdf", "--outdir", work, sourcePath], work, this.timeoutMs);
        pdfPath = join(work, "source.pdf");
      }
      const pdfStat = await stat(pdfPath);
      if (pdfStat.size <= 0 || pdfStat.size > this.maxOutputBytes) throw new Error("conversion_output_too_large");
      const info = await run(this.pdfInfoPath, [pdfPath], work, Math.min(this.timeoutMs, 15_000));
      const pages = Number(info.stdout.match(/^Pages:\s+(\d+)$/m)?.[1] ?? 0);
      if (!Number.isSafeInteger(pages) || pages < 1 || pages > this.maxPages) throw new Error("conversion_page_limit");
      await run(this.pdfToPpmPath, ["-png", "-r", String(this.renderDpi), "-f", "1", "-l", String(pages), pdfPath, join(work, "slide")], work, this.timeoutMs);
      const slideFiles = (await readdir(work)).filter((name) => /^slide-\d+\.png$/.test(name)).sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
      if (slideFiles.length !== pages) throw new Error("conversion_slide_count_mismatch");
      let totalBytes = pdfStat.size;
      const slideBytes: Buffer[] = [];
      for (const name of slideFiles) {
        const bytes = await readFile(join(work, basename(name)));
        totalBytes += bytes.byteLength;
        if (totalBytes > this.maxOutputBytes * 4) throw new Error("conversion_output_too_large");
        slideBytes.push(bytes);
      }
      const pdf = await readFile(pdfPath);
      outputAssetId = randomUUID();
      const storageKey = await this.storage.writeReady(outputAssetId, pdf);
      try {
        for (let index = 0; index < slideBytes.length; index += 1) await this.storage.writePreviewSlide(job.id, index + 1, slideBytes[index]);
        this.db.transaction(() => {
          this.db.run("INSERT INTO file_assets (id, uploaded_by_id, storage_key, original_name, mime_type, byte_size, sha256, purpose, library_scope, status) VALUES (?, ?, ?, ?, 'application/pdf', ?, ?, 'other', 'private', 'ready')", [outputAssetId, job.uploaded_by_id, storageKey, `${job.original_name.replace(/\.[^.]+$/, "")}-preview.pdf`, pdf.byteLength, createHash("sha256").update(pdf).digest("hex")]);
          this.db.run("UPDATE material_conversion_jobs SET output_asset_id = ?, page_count = ?, status = 'succeeded', finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'", [outputAssetId, pages, job.id]);
        });
      } catch (error) {
        await this.storage.remove(storageKey);
        await this.storage.removePreview(job.id);
        throw error;
      }
      return this.db.get("SELECT id, material_id, output_asset_id, status, page_count, created_at, started_at, finished_at FROM material_conversion_jobs WHERE id = ?", [job.id]);
    } catch (error) {
      this.db.run("UPDATE material_conversion_jobs SET status = 'failed', error_code = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'", [safeMessage(error).split(":", 1)[0] || "conversion_failed", safeMessage(error), job.id]);
      return this.db.get("SELECT id, material_id, status, error_code, error_message, created_at, started_at, finished_at FROM material_conversion_jobs WHERE id = ?", [job.id]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}
