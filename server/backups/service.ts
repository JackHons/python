/* eslint-disable @typescript-eslint/no-explicit-any -- backup manifests contain heterogeneous file/settings rows. */
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Actor } from "../education.ts";
import type { LocalDatabase } from "../db.ts";
import { assertDatabaseIntegrity, openLocalDatabase } from "../db.ts";
import { DomainError } from "../errors.ts";
import { AuditService } from "../audit/service.ts";

type Clock = () => Date;
type Scope = "database" | "files" | "full";
function now(clock: Clock) { return clock().toISOString(); }
function sha(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
function requireRow<T>(row: T | undefined, message: string) { if (!row) throw new DomainError("not_found", message, 404); return row; }
function inside(root: string, path: string) {
  const value = resolve(path);
  const relativePath = relative(root, value);
  if (relativePath && (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`))) throw new DomainError("invalid_storage_key", "Backup storage key is invalid");
  return value;
}

export class BackupService {
  private readonly db: LocalDatabase;
  private readonly databasePath: string;
  private readonly sourceStorageRoot: string;
  private readonly backupRoot: string;
  private readonly clock: Clock;
  private readonly audit: AuditService;
  private readonly retentionDays: number;
  private enabled: boolean;
  constructor(db: LocalDatabase, options: { databasePath: string; sourceStorageRoot: string; backupRoot: string; clock?: Clock; enabled?: boolean; retentionDays?: number }) {
    this.db = db; this.databasePath = options.databasePath === ":memory:" ? ":memory:" : resolve(options.databasePath); this.sourceStorageRoot = resolve(options.sourceStorageRoot); this.backupRoot = resolve(options.backupRoot); this.clock = options.clock ?? (() => new Date()); this.audit = new AuditService(db); this.enabled = options.enabled !== false; this.retentionDays = Math.max(1, options.retentionDays ?? 30);
  }

  private requireAdmin(actor: Actor) {
    const user = this.db.get<{ role: string; status: string }>("SELECT role, status FROM users WHERE id = ?", [actor.id]);
    if (!user || user.role !== actor.role || user.status !== "active") throw new DomainError("unauthorized", "Active session required", 401);
    if (actor.role !== "admin") throw new DomainError("forbidden", "Administrator permission required", 403);
  }
  private isEnabled() {
    const row = this.db.get<{ value_json: string }>("SELECT value_json FROM system_settings WHERE key = 'backup.enabled' AND sensitivity != 'encrypted_secret'");
    if (row) { try { return Boolean(JSON.parse(row.value_json)); } catch { return false; } }
    return this.enabled;
  }
  setEnabled(actor: Actor, enabled: boolean) {
    this.requireAdmin(actor); this.enabled = Boolean(enabled);
    this.db.run("INSERT INTO system_settings (key, value_json, sensitivity, updated_by_id, updated_at) VALUES ('backup.enabled', ?, 'admin_only', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, sensitivity = excluded.sensitivity, updated_by_id = excluded.updated_by_id, updated_at = excluded.updated_at", [JSON.stringify(this.enabled), actor.id, now(this.clock)]);
    this.audit.record(actor, { action: "backup.settings_updated", entityType: "backup_settings", entityId: "global", metadata: { enabled: this.enabled } });
    return { enabled: this.enabled };
  }
  settings(actor: Actor) { this.requireAdmin(actor); return { enabled: this.isEnabled(), retentionDays: this.retentionDays }; }

  private async filesManifest(directory: string, scope: Scope) {
    const files: Array<{ source: string; target: string; byteSize: number; sha256: string }> = [];
    if (scope === "database") return files;
    const assets = resolve(this.sourceStorageRoot, "assets");
    let names: string[] = [];
    try { names = await readdir(assets); } catch (error) { if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const name of names) {
      if (!/^.+\.bin$/i.test(name)) continue;
      const source = inside(this.sourceStorageRoot, resolve(assets, name));
      const bytes = await readFile(source);
      files.push({ source: `assets/${name}`, target: `assets/${name}`, byteSize: bytes.byteLength, sha256: sha(bytes) });
    }
    return files;
  }

  async createBackup(actor: Actor, input: { trigger?: "manual" | "scheduled"; scope?: Scope }) {
    this.requireAdmin(actor);
    const trigger = input.trigger ?? "manual";
    const scope = input.scope ?? "full";
    if (trigger === "scheduled" && !this.isEnabled()) {
      this.audit.record(actor, { action: "backup.skipped_disabled", entityType: "backup", result: "success", metadata: { trigger, scope } });
      return { skipped: true, reason: "disabled" };
    }
    if (this.databasePath === ":memory:") throw new DomainError("backup_database_unavailable", "A file-backed database is required for backup");
    const id = randomUUID();
    const directory = inside(this.backupRoot, resolve(this.backupRoot, "backups", id));
    const databaseFile = resolve(directory, "database.sqlite");
    this.db.run("INSERT INTO backup_records (id, triggered_by_id, trigger, scope, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)", [id, actor.id, trigger, scope, now(this.clock)]);
    try {
      await mkdir(directory, { recursive: true });
      const manifest: Record<string, unknown> = { manifestVersion: "v1", id, createdAt: now(this.clock), scope, excluded: ["quarantine", "runner-temp", "api_keys_plaintext", "admin_only_settings"], database: null, files: [], settings: this.db.all("SELECT key, value_json, sensitivity FROM system_settings WHERE sensitivity = 'public' AND key != 'backup.enabled'") };
      if (scope === "database" || scope === "full") {
        this.db.native.exec("PRAGMA wal_checkpoint(FULL)");
        await copyFile(this.databasePath, databaseFile);
        const bytes = await readFile(databaseFile);
        manifest.database = { path: "database.sqlite", byteSize: bytes.byteLength, sha256: sha(bytes) };
      }
      const files = await this.filesManifest(directory, scope);
      manifest.files = files;
      for (const file of files) { await mkdir(resolve(directory, "assets"), { recursive: true }); await copyFile(resolve(this.sourceStorageRoot, file.source), resolve(directory, file.target)); }
      const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
      const manifestPath = resolve(directory, "manifest.json");
      await writeFile(manifestPath, manifestBytes, { flag: "wx", mode: 0o600 });
      const manifestHash = sha(manifestBytes);
      const key = `backups/${id}/manifest.json`;
      const expiry = new Date(this.clock().getTime() + this.retentionDays * 86400000).toISOString();
      this.db.run("UPDATE backup_records SET status = 'verified', storage_key = ?, checksum = ?, byte_size = ?, expires_at = ?, started_at = ?, finished_at = ?, verified_at = ? WHERE id = ?", [key, manifestHash, manifestBytes.byteLength, expiry, now(this.clock), now(this.clock), now(this.clock), id]);
      this.audit.record(actor, { action: "backup.created", entityType: "backup", entityId: id, metadata: { scope, checksum: manifestHash, files: files.length } });
      return this.db.get("SELECT * FROM backup_records WHERE id = ?", [id]);
    } catch (error) {
      this.db.run("UPDATE backup_records SET status = 'failed', error_code = ?, error_message = ?, finished_at = ? WHERE id = ?", [error instanceof DomainError ? error.code : "backup_failed", error instanceof Error ? error.message.slice(0, 200) : "Backup failed", now(this.clock), id]);
      this.audit.record(actor, { action: "backup.failed", entityType: "backup", entityId: id, result: "failure", metadata: { errorCode: error instanceof DomainError ? error.code : "backup_failed" } });
      throw error;
    }
  }
  create(actor: Actor, input: { trigger?: "manual" | "scheduled"; scope?: Scope }) { return this.createBackup(actor, input); }

  list(actor: Actor) { this.requireAdmin(actor); return this.db.all("SELECT * FROM backup_records ORDER BY created_at DESC"); }

  async verify(actor: Actor, backupId: string) {
    this.requireAdmin(actor);
    const record = requireRow<Record<string, any>>(this.db.get("SELECT * FROM backup_records WHERE id = ?", [backupId]), "Backup not found");
    if (!record.storage_key) throw new DomainError("backup_unavailable", "Backup manifest is unavailable");
    const directory = inside(this.backupRoot, resolve(this.backupRoot, "backups", backupId));
    const manifestBytes = await readFile(resolve(directory, "manifest.json"));
    if (sha(manifestBytes) !== record.checksum) throw new DomainError("backup_checksum_mismatch", "Backup manifest checksum mismatch", 500);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as { database?: { path: string; sha256: string }; files: Array<{ target: string; sha256: string }> };
    if (manifest.database) { const bytes = await readFile(resolve(directory, manifest.database.path)); if (sha(bytes) !== manifest.database.sha256) throw new DomainError("backup_checksum_mismatch", "Backup database checksum mismatch", 500); }
    for (const file of manifest.files ?? []) { const bytes = await readFile(resolve(directory, file.target)); if (sha(bytes) !== file.sha256) throw new DomainError("backup_checksum_mismatch", "Backup file checksum mismatch", 500); }
    this.audit.record(actor, { action: "backup.verified", entityType: "backup", entityId: backupId, metadata: { checksum: record.checksum } });
    return { backupId, checksum: record.checksum, valid: true };
  }

  async restore(actor: Actor, backupId: string, targetDirectory: string) {
    this.requireAdmin(actor);
    requireRow(this.db.get("SELECT * FROM backup_records WHERE id = ?", [backupId]), "Backup not found");
    await this.verify(actor, backupId);
    const target = resolve(targetDirectory);
    if (this.databasePath === target || this.databasePath.startsWith(`${target}/`)) throw new DomainError("restore_target_current_db", "Restore target must be isolated from the current database");
    const source = inside(this.backupRoot, resolve(this.backupRoot, "backups", backupId));
    await mkdir(target, { recursive: true });
    if ((await readdir(target)).length > 0) throw new DomainError("restore_target_not_empty", "Restore target must be empty");
    const manifest = JSON.parse(new TextDecoder().decode(await readFile(resolve(source, "manifest.json")))) as { database?: { path: string; sha256: string }; files: Array<{ target: string; sha256: string }> };
    if (!manifest.database) throw new DomainError("restore_database_missing", "Backup does not contain a database");
    await copyFile(resolve(source, manifest.database.path), resolve(target, "database.sqlite"));
    if (manifest.files?.length) { await mkdir(resolve(target, "assets"), { recursive: true }); for (const file of manifest.files) await copyFile(resolve(source, file.target), resolve(target, file.target)); }
    const restored = openLocalDatabase(resolve(target, "database.sqlite"));
    try {
      const integrity = assertDatabaseIntegrity(restored);
      if (integrity.foreignKeys !== 1 || integrity.integrity !== "ok") throw new DomainError("restore_integrity_failed", "Restored database integrity failed");
      this.audit.record(actor, { action: "backup.restore_verified", entityType: "backup", entityId: backupId, metadata: { target: "isolated", foreignKeys: integrity.foreignKeys, integrity: integrity.integrity } });
      return { backupId, targetDirectory: target, integrity };
    } finally { restored.close(); }
  }
  restoreBackup(actor: Actor, backupId: string, targetDirectory: string) { return this.restore(actor, backupId, targetDirectory); }

  async cleanupExpired(actor: Actor) {
    this.requireAdmin(actor);
    const rows = this.db.all<{ id: string }>("SELECT id FROM backup_records WHERE expires_at IS NOT NULL AND expires_at <= ? AND deleted_at IS NULL", [now(this.clock)]);
    for (const row of rows) await rm(resolve(this.backupRoot, "backups", row.id), { recursive: true, force: true });
    this.db.run("UPDATE backup_records SET deleted_at = ?, status = 'failed', error_code = 'retained_expired' WHERE expires_at IS NOT NULL AND expires_at <= ? AND deleted_at IS NULL", [now(this.clock), now(this.clock)]);
    this.audit.record(actor, { action: "backup.cleanup", entityType: "backup", metadata: { count: rows.length } });
    return { deleted: rows.length };
  }
}
