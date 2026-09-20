/* eslint-disable @typescript-eslint/no-explicit-any -- SQLite row shapes are runtime-defined and vary by projection. */
import { createHash, randomUUID } from "node:crypto";
import type { Actor } from "./education.ts";
import type { LocalDatabase } from "./db.ts";
import { DomainError } from "./errors.ts";
import { LocalFileStorage, validateFileMetadata, validateFileSignature } from "./storage.ts";
import { assertAssignmentSubmissionOpen } from "./classroom/guard.ts";

const STAFF = new Set(["admin", "teacher"]);
const QUESTION_TYPES = new Set(["multiple_choice", "fill_blank", "short_answer", "code_fill", "python_code", "file_upload", "project_upload"]);
type Clock = () => Date;

function now(clock: Clock) { return clock().toISOString(); }
function txt(value: unknown) { return String(value ?? "").trim(); }
function jsonValue(value: unknown, field: string, fallback: unknown = null) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { throw new DomainError("invalid_json", field + " must be valid JSON"); }
}
function jsonString(value: unknown, field: string, fallback: unknown = null) {
  const parsed = jsonValue(value, field, fallback);
  return parsed === null ? null : JSON.stringify(parsed);
}
function requireRow<T>(row: T | undefined, message: string): T {
  if (!row) throw new DomainError("not_found", message, 404);
  return row;
}
function parseTime(value: unknown) {
  if (!value) return null;
  const raw = String(value);
  const parsed = new Date(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z");
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function audit(db: LocalDatabase, actorId: string | null, action: string, entityType: string, entityId: string | null, result: "success" | "denied" | "failure", metadata: Record<string, unknown> = {}) {
  db.run("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, result, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)", [randomUUID(), actorId, action, entityType, entityId, result, JSON.stringify(metadata)]);
}
function canManageCourse(db: LocalDatabase, actor: Actor, courseId: string) {
  if (actor.role === "admin") return true;
  if (actor.role !== "teacher") return false;
  return Boolean(db.get("SELECT 1 FROM courses c WHERE c.id = ? AND (c.owner_teacher_id = ? OR EXISTS (SELECT 1 FROM course_class_assignments cca JOIN class_memberships cm ON cm.class_id = cca.class_id WHERE cca.course_id = c.id AND cm.user_id = ? AND cm.member_role = 'teacher' AND cm.status = 'active'))", [courseId, actor.id, actor.id]));
}
function canViewCourse(db: LocalDatabase, actor: Actor, courseId: string) {
  if (actor.role === "admin") return true;
  if (actor.role === "teacher") return canManageCourse(db, actor, courseId);
  return Boolean(db.get("SELECT 1 FROM course_enrollments ce JOIN courses c ON c.id = ce.course_id WHERE ce.course_id = ? AND ce.student_id = ? AND ce.status = 'active' AND c.status = 'published'", [courseId, actor.id]));
}
function canViewActiveCourse(db: LocalDatabase, actor: Actor, courseId: string) {
  return Boolean(db.get("SELECT 1 FROM courses WHERE id = ? AND status != 'archived'", [courseId])) && canViewCourse(db, actor, courseId);
}
function requireStaff(actor: Actor) {
  if (!STAFF.has(actor.role)) throw new DomainError("forbidden", "Staff permission required", 403);
}

type FilePurpose = "material_library" | "submission_attachment" | "other";
type LibraryScope = "private" | "school";
function safeFileAsset(row: Record<string, any> | undefined, deduplicated = false, actorId?: string) {
  if (!row) return undefined;
  return {
    id: row.id, originalName: row.original_name, mimeType: row.mime_type,
    byteSize: row.byte_size, sha256: row.sha256, status: row.status, purpose: row.purpose,
    libraryScope: row.library_scope, createdAt: row.created_at, deduplicated,
    rootAssetId: row.root_asset_id ?? row.id, previousAssetId: row.previous_asset_id ?? null,
    versionNumber: Number(row.version_number ?? 1), latestAssetId: row.latest_asset_id ?? row.id,
    updateAvailable: Boolean(row.latest_asset_id && row.latest_asset_id !== row.id),
    ownedByMe: actorId ? row.uploaded_by_id === actorId : undefined,
  };
}

export function safeStudentQuestionProjection(row: Record<string, unknown>, includeSolution = false) {
  const snapshot = typeof row.question_snapshot_json === "string" ? JSON.parse(row.question_snapshot_json) : row;
  const tests = Array.isArray(snapshot.testCases) ? snapshot.testCases.filter((item: Record<string, unknown>) => item.visibility === "public").map((item: Record<string, unknown>) => ({
    id: item.id, label: item.label, visibility: "public", inputJson: item.inputJson, expectedOutput: item.expectedOutput,
    comparisonMode: item.comparisonMode, tolerance: item.tolerance, position: item.position,
  })) : [];
  return {
    id: snapshot.id, type: snapshot.type, titleZh: snapshot.titleZh, titleEn: snapshot.titleEn,
    promptZh: snapshot.promptZh, promptEn: snapshot.promptEn, options: snapshot.optionsJson ?? null,
    starterCode: snapshot.starterCode ?? null, requiredConcepts: snapshot.requiredConceptsJson ?? null,
    maxScore: snapshot.maxScore, testCases: tests,
    ...(includeSolution ? { answerKey: snapshot.answerKeyJson ?? null, explanationZh: snapshot.explanationZh ?? null, explanationEn: snapshot.explanationEn ?? null, solutionCode: snapshot.solutionCode ?? null } : {}),
  };
}

export class MaterialService {
  private readonly clock: Clock;
  private readonly db: LocalDatabase;
  private readonly storage: LocalFileStorage;
  constructor(db: LocalDatabase, storage: LocalFileStorage, clock: Clock = () => new Date()) { this.db = db; this.storage = storage; this.clock = clock; }
  private unit(unitId: string) { return this.db.get<{ id: string; course_id: string; status: string; course_status: string }>("SELECT u.id, u.course_id, u.status, c.status AS course_status FROM units u JOIN courses c ON c.id = u.course_id WHERE u.id = ?", [unitId]); }
  private material(materialId: string) { return this.db.get<{ id: string; unit_id: string; course_id: string; status: string; unit_status: string; course_status: string; file_asset_id: string | null; published_at: string | null }>("SELECT m.id, m.unit_id, u.course_id, m.status, u.status AS unit_status, c.status AS course_status, m.file_asset_id, m.published_at FROM materials m JOIN units u ON u.id = m.unit_id JOIN courses c ON c.id = u.course_id WHERE m.id = ?", [materialId]); }
  private assertUnitManage(actor: Actor, unitId: string) {
    const unit = requireRow(this.unit(unitId), "Unit not found");
    if (!canManageCourse(this.db, actor, unit.course_id)) throw new DomainError("forbidden", "You cannot manage this unit", 403);
    return unit;
  }
  async quarantineUpload(actor: Actor, input: { originalName: string; mimeType: string; bytes: Uint8Array; purpose?: FilePurpose; libraryScope?: LibraryScope; previousAssetId?: string }) {
    const user = this.db.get<{ role: string; status: string }>("SELECT role, status FROM users WHERE id = ?", [actor.id]);
    if (!user || user.role !== actor.role || user.status !== "active") throw new DomainError("unauthorized", "Active session required", 401);
    const purpose = input.purpose ?? (actor.role === "student" ? "submission_attachment" : "material_library");
    if (!["material_library", "submission_attachment", "other"].includes(purpose)) throw new DomainError("invalid_input", "File purpose is invalid");
    if (purpose === "material_library") requireStaff(actor);
    const libraryScope = input.libraryScope ?? (purpose === "material_library" ? "school" : "private");
    if (!["private", "school"].includes(libraryScope)) throw new DomainError("invalid_input", "Library scope is invalid");
    validateFileMetadata(input.originalName, input.mimeType, input.bytes.byteLength, this.storage.maxBytes);
    const sha256 = createHash("sha256").update(input.bytes).digest("hex");
    let previous: Record<string, any> | undefined;
    if (input.previousAssetId) {
      previous = requireRow(this.db.get<Record<string, any>>(`SELECT fa.*, mav.root_asset_id, mav.version_number FROM file_assets fa
        JOIN material_asset_versions mav ON mav.asset_id = fa.id WHERE fa.id = ? AND fa.purpose = 'material_library'`, [input.previousAssetId]), "Previous material version not found");
      if (actor.role !== "admin" && previous.uploaded_by_id !== actor.id) throw new DomainError("forbidden", "Only the owner can upload a new material version", 403);
      if (previous.status !== "ready") throw new DomainError("file_not_ready", "Previous material version is not ready");
      const latest = this.db.get<{ asset_id: string }>("SELECT asset_id FROM material_asset_versions WHERE root_asset_id = ? ORDER BY version_number DESC LIMIT 1", [previous.root_asset_id]);
      if (latest?.asset_id !== previous.id) throw new DomainError("version_conflict", "New versions must extend the current latest material version", 409);
    }
    if (purpose === "material_library") {
      const existing = this.db.get<Record<string, any>>(`SELECT fa.*, mav.root_asset_id, mav.previous_asset_id, mav.version_number,
        (SELECT asset_id FROM material_asset_versions WHERE root_asset_id = mav.root_asset_id ORDER BY version_number DESC LIMIT 1) AS latest_asset_id
        FROM file_assets fa LEFT JOIN material_asset_versions mav ON mav.asset_id = fa.id
        WHERE fa.uploaded_by_id = ? AND fa.sha256 = ? AND fa.purpose = 'material_library' AND fa.status IN ('ready', 'quarantined')
        ORDER BY CASE fa.status WHEN 'ready' THEN 0 ELSE 1 END, fa.created_at LIMIT 1`, [actor.id, sha256]);
      if (existing) {
        if (previous && existing.id !== previous.id) throw new DomainError("version_conflict", "A new version cannot reuse content from a different point in its history", 409);
        return safeFileAsset(existing, true, actor.id);
      }
    }
    const id = randomUUID();
    const asset = await this.storage.quarantine(id, input.originalName, input.mimeType, input.bytes);
    try {
      this.db.transaction(() => {
        this.db.run("INSERT INTO file_assets (id, uploaded_by_id, storage_key, original_name, mime_type, byte_size, sha256, purpose, library_scope, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'quarantined')", [id, actor.id, asset.storageKey, asset.originalName, asset.mimeType, asset.byteSize, asset.sha256, purpose, libraryScope]);
        if (purpose === "material_library") {
          const rootAssetId = previous?.root_asset_id ?? id;
          const versionNumber = previous ? (this.db.get<{ value: number }>("SELECT COALESCE(MAX(version_number), 0) + 1 AS value FROM material_asset_versions WHERE root_asset_id = ?", [rootAssetId])?.value ?? 1) : 1;
          this.db.run("INSERT INTO material_asset_versions (asset_id, root_asset_id, previous_asset_id, version_number, created_by_id) VALUES (?, ?, ?, ?, ?)", [id, rootAssetId, previous?.id ?? null, versionNumber, actor.id]);
        }
      });
    } catch (error) {
      await this.storage.removeQuarantine(id);
      throw error;
    }
    audit(this.db, actor.id, "file.quarantined", "file_asset", id, "success", { byteSize: asset.byteSize, mimeType: asset.mimeType });
    return safeFileAsset(this.db.get(`SELECT fa.*, mav.root_asset_id, mav.previous_asset_id, mav.version_number,
      (SELECT asset_id FROM material_asset_versions WHERE root_asset_id = mav.root_asset_id ORDER BY version_number DESC LIMIT 1) AS latest_asset_id
      FROM file_assets fa LEFT JOIN material_asset_versions mav ON mav.asset_id = fa.id WHERE fa.id = ?`, [id]), false, actor.id);
  }
  async releaseUpload(actor: Actor, assetId: string) {
    const asset = requireRow(this.db.get<Record<string, any>>("SELECT * FROM file_assets WHERE id = ?", [assetId]), "File asset not found");
    if (actor.role !== "admin" && asset.uploaded_by_id !== actor.id) throw new DomainError("forbidden", "You cannot release this file", 403);
    if (asset.status === "quarantined") {
      const bytes = await this.storage.readQuarantine(assetId);
      validateFileSignature(asset.original_name, asset.mime_type, bytes);
      await this.storage.promote(assetId);
      this.db.run("UPDATE file_assets SET status = 'ready' WHERE id = ?", [assetId]);
      audit(this.db, actor.id, "file.released", "file_asset", assetId, "success");
    }
    return safeFileAsset(this.db.get(`SELECT fa.*, mav.root_asset_id, mav.previous_asset_id, mav.version_number,
      (SELECT asset_id FROM material_asset_versions WHERE root_asset_id = mav.root_asset_id ORDER BY version_number DESC LIMIT 1) AS latest_asset_id
      FROM file_assets fa LEFT JOIN material_asset_versions mav ON mav.asset_id = fa.id WHERE fa.id = ?`, [assetId]), false, actor.id);
  }
  listAvailableLibraryAssets(actor: Actor) {
    requireStaff(actor);
    const rows = actor.role === "admin"
      ? this.db.all<Record<string, any>>(`SELECT fa.*, mav.root_asset_id, mav.previous_asset_id, mav.version_number,
          (SELECT asset_id FROM material_asset_versions WHERE root_asset_id = mav.root_asset_id ORDER BY version_number DESC LIMIT 1) AS latest_asset_id
          FROM file_assets fa LEFT JOIN material_asset_versions mav ON mav.asset_id = fa.id
          WHERE fa.purpose = 'material_library' AND fa.status = 'ready' ORDER BY fa.created_at DESC`)
      : this.db.all<Record<string, any>>(`SELECT fa.*, mav.root_asset_id, mav.previous_asset_id, mav.version_number,
          (SELECT asset_id FROM material_asset_versions WHERE root_asset_id = mav.root_asset_id ORDER BY version_number DESC LIMIT 1) AS latest_asset_id
          FROM file_assets fa LEFT JOIN material_asset_versions mav ON mav.asset_id = fa.id
          WHERE fa.purpose = 'material_library' AND fa.status = 'ready' AND (fa.uploaded_by_id = ? OR fa.library_scope = 'school') ORDER BY fa.created_at DESC`, [actor.id]);
    return rows.map((row) => safeFileAsset(row, false, actor.id));
  }
  updateLibraryScope(actor: Actor, assetId: string, libraryScope: LibraryScope) {
    requireStaff(actor);
    if (!["private", "school"].includes(libraryScope)) throw new DomainError("invalid_input", "Library scope is invalid");
    const asset = requireRow(this.db.get<Record<string, any>>("SELECT * FROM file_assets WHERE id = ? AND purpose = 'material_library'", [assetId]), "Library asset not found");
    if (actor.role !== "admin" && asset.uploaded_by_id !== actor.id) throw new DomainError("forbidden", "Only the owner can change library scope", 403);
    this.db.run("UPDATE file_assets SET library_scope = ? WHERE id = ?", [libraryScope, assetId]);
    audit(this.db, actor.id, "file.library_scope_changed", "file_asset", assetId, "success", { libraryScope });
    return safeFileAsset(this.db.get("SELECT * FROM file_assets WHERE id = ?", [assetId]), false, actor.id);
  }
  async deleteFileAsset(actor: Actor, assetId: string) {
    const asset = requireRow(this.db.get<Record<string, any>>("SELECT * FROM file_assets WHERE id = ?", [assetId]), "File asset not found");
    if (actor.role !== "admin" && asset.uploaded_by_id !== actor.id) throw new DomainError("forbidden", "Only the owner can delete this file", 403);
    if (asset.status === "deleted") return safeFileAsset(asset, false, actor.id);
    const references = this.db.get<{ count: number }>(`SELECT
      (SELECT COUNT(*) FROM materials WHERE file_asset_id = ?) +
      (SELECT COUNT(*) FROM submission_answers WHERE file_asset_id = ?) +
      (SELECT COUNT(*) FROM material_conversion_jobs WHERE source_asset_id = ? OR output_asset_id = ?) +
      (SELECT COUNT(*) FROM material_asset_versions WHERE asset_id != ? AND (root_asset_id = ? OR previous_asset_id = ?)) AS count`, [assetId, assetId, assetId, assetId, assetId, assetId, assetId])?.count ?? 0;
    if (references > 0) throw new DomainError("dependency_conflict", "Referenced files cannot be deleted", 409);
    const priorStatus = asset.status;
    this.db.run("UPDATE file_assets SET status = 'deleted' WHERE id = ?", [assetId]);
    try {
      if (priorStatus === "quarantined") await this.storage.removeQuarantine(assetId);
      else if (priorStatus === "ready") await this.storage.remove(asset.storage_key);
    } catch (error) {
      this.db.run("UPDATE file_assets SET status = ? WHERE id = ?", [priorStatus, assetId]);
      throw error;
    }
    audit(this.db, actor.id, "file.deleted", "file_asset", assetId, "success", { priorStatus });
    return safeFileAsset(this.db.get("SELECT * FROM file_assets WHERE id = ?", [assetId]), false, actor.id);
  }
  private canUseLibraryAsset(actor: Actor, asset: Record<string, any>) {
    return actor.role === "admin" || (asset.purpose === "material_library" && (asset.uploaded_by_id === actor.id || asset.library_scope === "school"));
  }
  async downloadLibraryAsset(actor: Actor, assetId: string) {
    requireStaff(actor);
    const asset = requireRow(this.db.get<Record<string, any>>("SELECT * FROM file_assets WHERE id = ? AND purpose = 'material_library'", [assetId]), "Library asset not found");
    if (asset.status !== "ready" || !this.canUseLibraryAsset(actor, asset)) throw new DomainError("forbidden", "You cannot download this library asset", 403);
    return { bytes: await this.storage.read(asset.storage_key), filename: asset.original_name, mimeType: asset.mime_type, sha256: asset.sha256 };
  }
  async createMaterial(actor: Actor, unitId: string, input: { kind: string; titleZh: string; titleEn?: string; bodyZh?: string; bodyEn?: string; sourceUrl?: string; fileAssetId?: string; allowDownload?: boolean; position?: number; bindingMode?: "reference" | "copy" }) {
    requireStaff(actor);
    const unit = this.assertUnitManage(actor, unitId);
    if (!txt(input.titleZh) || !["document", "slides", "web_content", "image", "video_link", "data_file", "archive"].includes(input.kind)) throw new DomainError("invalid_input", "Material title and kind are required");
    if (input.fileAssetId) {
      const asset = requireRow(this.db.get<Record<string, any>>("SELECT * FROM file_assets WHERE id = ?", [input.fileAssetId]), "File asset not found");
      if (asset.status !== "ready") throw new DomainError("file_not_ready", "File must be released from quarantine before attaching");
      if (!this.canUseLibraryAsset(actor, asset)) throw new DomainError("forbidden", "You cannot attach this library file", 403);
    }
    const bindingMode = input.bindingMode ?? "reference";
    if (!["reference", "copy"].includes(bindingMode)) throw new DomainError("invalid_input", "Material binding mode is invalid");
    const id = randomUUID();
    this.db.run("INSERT INTO materials (id, unit_id, created_by_id, file_asset_id, kind, title_zh, title_en, body_zh, body_en, source_url, position, allow_download, asset_binding_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, unitId, actor.id, input.fileAssetId ?? null, input.kind, txt(input.titleZh), txt(input.titleEn) || null, txt(input.bodyZh) || null, txt(input.bodyEn) || null, txt(input.sourceUrl) || null, input.position ?? 0, input.allowDownload === false ? 0 : 1, bindingMode]);
    audit(this.db, actor.id, "material.created", "material", id, "success", { courseId: unit.course_id });
    return this.listMaterials(actor, unitId).find((item: any) => item.id === id);
  }
  listMaterials(actor: Actor, unitId: string) {
    const unit = requireRow(this.unit(unitId), "Unit not found");
    if (!canViewActiveCourse(this.db, actor, unit.course_id)) throw new DomainError("not_found", "Unit not found", 404);
    if (actor.role === "student" && (unit.status !== "published" || unit.course_status !== "published")) throw new DomainError("not_found", "Unit not found", 404);
    const projection = `SELECT m.id, m.unit_id, m.file_asset_id, m.asset_binding_mode, m.kind, m.title_zh, m.title_en, m.body_zh, m.body_en, m.source_url, m.position, m.allow_download, m.status, m.published_at,
      fa.original_name AS file_name, fa.mime_type AS file_mime_type, fa.byte_size AS file_byte_size, fa.status AS file_status, fa.library_scope AS file_library_scope,
      mav.version_number AS file_version_number, latest.asset_id AS latest_file_asset_id,
      CASE WHEN latest.asset_id IS NOT NULL AND latest.asset_id != m.file_asset_id THEN 1 ELSE 0 END AS update_available,
      cj.id AS conversion_job_id, cj.kind AS conversion_kind, cj.status AS conversion_status, cj.error_code AS conversion_error_code, cj.page_count AS conversion_page_count
      FROM materials m LEFT JOIN file_assets fa ON fa.id = m.file_asset_id
      LEFT JOIN material_asset_versions mav ON mav.asset_id = m.file_asset_id
      LEFT JOIN material_asset_versions latest ON latest.root_asset_id = mav.root_asset_id AND latest.version_number = (SELECT MAX(v2.version_number) FROM material_asset_versions v2 WHERE v2.root_asset_id = mav.root_asset_id)
      LEFT JOIN material_conversion_jobs cj ON cj.id = (SELECT id FROM material_conversion_jobs WHERE material_id = m.id ORDER BY created_at DESC LIMIT 1)`;
    if (actor.role === "student") return this.db.all(projection + " WHERE m.unit_id = ? AND m.status = 'published' AND (m.published_at IS NULL OR m.published_at <= ?) AND (m.file_asset_id IS NULL OR fa.status = 'ready') ORDER BY m.position, m.created_at", [unitId, this.clock().toISOString()]);
    return this.db.all(projection + " WHERE m.unit_id = ? AND m.status != 'archived' ORDER BY m.position, m.created_at", [unitId]);
  }
  updateMaterial(actor: Actor, materialId: string, input: Partial<{ titleZh: string; titleEn: string; bodyZh: string; bodyEn: string; sourceUrl: string; position: number; allowDownload: boolean; status: "draft" | "published" | "archived" }>) {
    requireStaff(actor);
    const material = requireRow(this.material(materialId), "Material not found");
    if (!canViewActiveCourse(this.db, actor, material.course_id) || !canManageCourse(this.db, actor, material.course_id)) throw new DomainError("not_found", "Material not found", 404);
    const current = requireRow(this.db.get<Record<string, any>>("SELECT * FROM materials WHERE id = ?", [materialId]), "Material not found");
    if (input.status === "published" && material.file_asset_id) {
      const asset = this.db.get<{ status: string }>("SELECT status FROM file_assets WHERE id = ?", [material.file_asset_id]);
      if (asset?.status !== "ready") throw new DomainError("file_not_ready", "Material file is not ready");
    }
    const status = input.status ?? current.status;
    this.db.run("UPDATE materials SET title_zh = ?, title_en = ?, body_zh = ?, body_en = ?, source_url = ?, position = ?, allow_download = ?, status = ?, published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END, updated_at = ? WHERE id = ?", [txt(input.titleZh) || current.title_zh, txt(input.titleEn) || current.title_en, txt(input.bodyZh) || current.body_zh, txt(input.bodyEn) || current.body_en, txt(input.sourceUrl) || current.source_url, input.position ?? current.position, input.allowDownload === undefined ? current.allow_download : input.allowDownload ? 1 : 0, status, status, now(this.clock), now(this.clock), materialId]);
    audit(this.db, actor.id, "material.updated", "material", materialId, "success", { status });
    return this.db.get("SELECT * FROM materials WHERE id = ?", [materialId]);
  }
  archiveMaterial(actor: Actor, materialId: string) {
    return this.updateMaterial(actor, materialId, { status: "archived" });
  }
  upgradeMaterialAsset(actor: Actor, materialId: string, targetAssetId?: string) {
    requireStaff(actor);
    const material = requireRow(this.material(materialId), "Material not found");
    if (!canViewActiveCourse(this.db, actor, material.course_id) || !canManageCourse(this.db, actor, material.course_id)) throw new DomainError("not_found", "Material not found", 404);
    if (!material.file_asset_id) throw new DomainError("invalid_input", "Material has no pinned file version");
    const current = requireRow(this.db.get<Record<string, any>>("SELECT * FROM material_asset_versions WHERE asset_id = ?", [material.file_asset_id]), "Material version not found");
    const target = targetAssetId
      ? requireRow(this.db.get<Record<string, any>>("SELECT mav.*, fa.status, fa.purpose, fa.library_scope, fa.uploaded_by_id FROM material_asset_versions mav JOIN file_assets fa ON fa.id = mav.asset_id WHERE mav.asset_id = ?", [targetAssetId]), "Target material version not found")
      : requireRow(this.db.get<Record<string, any>>("SELECT mav.*, fa.status, fa.purpose, fa.library_scope, fa.uploaded_by_id FROM material_asset_versions mav JOIN file_assets fa ON fa.id = mav.asset_id WHERE mav.root_asset_id = ? ORDER BY mav.version_number DESC LIMIT 1", [current.root_asset_id]), "Target material version not found");
    if (target.root_asset_id !== current.root_asset_id || target.status !== "ready" || !this.canUseLibraryAsset(actor, target)) throw new DomainError("forbidden", "You cannot use this material version", 403);
    this.db.run("UPDATE materials SET file_asset_id = ?, updated_at = ? WHERE id = ?", [target.asset_id, now(this.clock), materialId]);
    audit(this.db, actor.id, "material.asset_upgraded", "material", materialId, "success", { fromAssetId: material.file_asset_id, toAssetId: target.asset_id, versionNumber: target.version_number });
    return this.db.get("SELECT * FROM materials WHERE id = ?", [materialId]);
  }
  createConversionJob(actor: Actor, materialId: string, kind: "ppt_to_web" | "document_preview" = "ppt_to_web") {
    requireStaff(actor);
    const material = requireRow(this.material(materialId), "Material not found");
    if (!canViewActiveCourse(this.db, actor, material.course_id) || !canManageCourse(this.db, actor, material.course_id)) throw new DomainError("not_found", "Material not found", 404);
    if (!material.file_asset_id) throw new DomainError("invalid_input", "A source file is required");
    const source = requireRow(this.db.get<{ status: string; mime_type: string }>("SELECT status, mime_type FROM file_assets WHERE id = ?", [material.file_asset_id]), "Source asset not found");
    if (source.status !== "ready") throw new DomainError("file_not_ready", "Source file is not ready");
    if (kind === "ppt_to_web" && !["application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation"].includes(source.mime_type)) throw new DomainError("invalid_input", "PPT conversion requires a PPT or PPTX source");
    const active = this.db.get("SELECT * FROM material_conversion_jobs WHERE material_id = ? AND source_asset_id = ? AND kind = ? AND status IN ('queued', 'running') ORDER BY created_at DESC, id DESC LIMIT 1", [materialId, material.file_asset_id, kind]);
    if (active) return active;
    const id = randomUUID();
    this.db.run("INSERT INTO material_conversion_jobs (id, material_id, source_asset_id, kind) VALUES (?, ?, ?, ?)", [id, materialId, material.file_asset_id, kind]);
    audit(this.db, actor.id, "material.conversion_queued", "material_conversion_job", id, "success", { materialId, kind });
    return this.db.get("SELECT * FROM material_conversion_jobs WHERE id = ?", [id]);
  }
  getConversionStatus(actor: Actor, materialId: string) {
    const material = requireRow(this.material(materialId), "Material not found");
    if (!canViewActiveCourse(this.db, actor, material.course_id)) throw new DomainError("not_found", "Material not found", 404);
    if (actor.role === "student" && (material.status !== "published" || material.unit_status !== "published" || material.course_status !== "published" || (parseTime(material.published_at)?.getTime() ?? 0) > this.clock().getTime())) throw new DomainError("not_found", "Material not found", 404);
    return this.db.get("SELECT id, material_id, output_asset_id, kind, status, error_code, error_message, page_count, created_at, started_at, finished_at FROM material_conversion_jobs WHERE material_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", [materialId]) ?? null;
  }
  private previewJob(actor: Actor, materialId: string) {
    const material = requireRow(this.material(materialId), "Material not found");
    if (!canViewActiveCourse(this.db, actor, material.course_id)) throw new DomainError("not_found", "Material not found", 404);
    if (actor.role === "student" && (material.status !== "published" || material.unit_status !== "published" || material.course_status !== "published" || (parseTime(material.published_at)?.getTime() ?? 0) > this.clock().getTime())) throw new DomainError("not_found", "Material not found", 404);
    return requireRow(this.db.get<Record<string, any>>(`SELECT j.id, j.output_asset_id, j.page_count, f.storage_key, f.original_name, f.mime_type, f.status AS asset_status
      FROM material_conversion_jobs j JOIN file_assets f ON f.id = j.output_asset_id
      WHERE j.material_id = ? AND j.status = 'succeeded' ORDER BY j.created_at DESC, j.id DESC LIMIT 1`, [materialId]), "Material preview is not ready");
  }
  previewManifest(actor: Actor, materialId: string) {
    const job = this.previewJob(actor, materialId);
    const pageCount = Number(job.page_count ?? 0);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new DomainError("preview_unavailable", "Material preview is unavailable", 404);
    return {
      materialId,
      jobId: job.id,
      pageCount,
      pdfUrl: `/api/v1/materials/${materialId}/preview/pdf`,
      slides: Array.from({ length: pageCount }, (_, index) => ({ page: index + 1, url: `/api/v1/materials/${materialId}/preview/slides/${index + 1}` })),
    };
  }
  async downloadPreviewPdf(actor: Actor, materialId: string) {
    const job = this.previewJob(actor, materialId);
    if (job.asset_status !== "ready" || job.mime_type !== "application/pdf") throw new DomainError("preview_unavailable", "Material preview is unavailable", 404);
    return { bytes: await this.storage.read(job.storage_key), filename: job.original_name, mimeType: "application/pdf" };
  }
  async downloadPreviewSlide(actor: Actor, materialId: string, page: number) {
    const job = this.previewJob(actor, materialId);
    const pageCount = Number(job.page_count ?? 0);
    if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) throw new DomainError("not_found", "Preview slide not found", 404);
    return { bytes: await this.storage.readPreviewSlide(job.id, page), mimeType: "image/png" };
  }
  async downloadMaterial(actor: Actor, materialId: string) {
    const material = requireRow(this.db.get<{ course_id: string; file_asset_id: string | null; status: string; unit_status: string; course_status: string; allow_download: number; published_at: string | null }>("SELECT u.course_id, m.file_asset_id, m.status, u.status AS unit_status, c.status AS course_status, m.allow_download, m.published_at FROM materials m JOIN units u ON u.id = m.unit_id JOIN courses c ON c.id = u.course_id WHERE m.id = ?", [materialId]), "Material not found");
    if (!material.file_asset_id || !material.allow_download) throw new DomainError("download_unavailable", "Material download is unavailable", 404);
    if (actor.role === "student" && (material.status !== "published" || material.unit_status !== "published" || material.course_status !== "published" || !canViewActiveCourse(this.db, actor, material.course_id) || (parseTime(material.published_at)?.getTime() ?? 0) > this.clock().getTime())) throw new DomainError("not_found", "Material not found", 404);
    if (actor.role === "teacher" && (!canViewActiveCourse(this.db, actor, material.course_id) || !canManageCourse(this.db, actor, material.course_id))) throw new DomainError("not_found", "Material not found", 404);
    const asset = requireRow(this.db.get<{ storage_key: string; original_name: string; mime_type: string; status: string }>("SELECT storage_key, original_name, mime_type, status FROM file_assets WHERE id = ?", [material.file_asset_id]), "File asset not found");
    if (asset.status !== "ready") throw new DomainError("file_not_ready", "File is not ready");
    return { bytes: await this.storage.read(asset.storage_key), filename: asset.original_name, mimeType: asset.mime_type };
  }
}

export class QuestionService {
  private readonly clock: Clock;
  private readonly db: LocalDatabase;
  constructor(db: LocalDatabase, clock: Clock = () => new Date()) { this.db = db; this.clock = clock; }
  private question(id: string) {
    return this.db.get<Record<string, any>>("SELECT q.* FROM questions q JOIN courses c ON c.id = q.course_id WHERE q.id = ? AND c.status != 'archived'", [id]);
  }
  private manage(actor: Actor, courseId: string) {
    requireStaff(actor);
    if (!canViewActiveCourse(this.db, actor, courseId) || !canManageCourse(this.db, actor, courseId)) throw new DomainError("not_found", "Course not found", 404);
  }
  private validate(input: { type: string; titleZh: string; promptZh: string; optionsJson?: unknown; starterCode?: string; maxScore?: number }) {
    if (!QUESTION_TYPES.has(input.type) || !txt(input.titleZh) || !txt(input.promptZh)) throw new DomainError("invalid_input", "Question type, title and prompt are required");
    const options = jsonValue(input.optionsJson, "optionsJson");
    if (input.type === "multiple_choice" && (!Array.isArray(options) || options.length < 2)) throw new DomainError("invalid_input", "Multiple choice questions require at least two options");
    if ((input.type === "code_fill" || input.type === "python_code") && input.starterCode === undefined) throw new DomainError("invalid_input", "Code questions require starter code");
    if (input.maxScore !== undefined && (!Number.isFinite(input.maxScore) || input.maxScore < 0)) throw new DomainError("invalid_input", "Maximum score must be nonnegative");
    return options;
  }
  createQuestion(actor: Actor, input: { courseId: string; unitId?: string; rubricId?: string; type: string; titleZh: string; titleEn?: string; promptZh: string; promptEn?: string; optionsJson?: unknown; answerKeyJson?: unknown; explanationZh?: string; explanationEn?: string; starterCode?: string; solutionCode?: string; requiredConceptsJson?: unknown; maxScore?: number; sharingScope?: "private" | "course" | "school" }) {
    this.manage(actor, input.courseId);
    const options = this.validate(input);
    if (input.unitId) {
      const unit = requireRow<{ course_id: string }>(this.db.get("SELECT course_id FROM units WHERE id = ?", [input.unitId]), "Unit not found");
      if (unit.course_id !== input.courseId) throw new DomainError("invalid_reference", "Question unit and course must match");
    }
    if (input.rubricId) {
      const rubric = requireRow<{ course_id: string | null }>(this.db.get("SELECT course_id FROM rubrics WHERE id = ?", [input.rubricId]), "Rubric not found");
      if (rubric.course_id !== null && rubric.course_id !== input.courseId) throw new DomainError("invalid_reference", "Question rubric and course must match");
    }
    const owner = actor.role === "teacher" ? actor.id : this.db.get<{ owner_teacher_id: string }>("SELECT owner_teacher_id FROM courses WHERE id = ?", [input.courseId])?.owner_teacher_id;
    if (!owner) throw new DomainError("invalid_reference", "Course owner is missing");
    const id = randomUUID();
    this.db.run("INSERT INTO questions (id, owner_teacher_id, course_id, unit_id, rubric_id, type, title_zh, title_en, prompt_zh, prompt_en, options_json, answer_key_json, explanation_zh, explanation_en, starter_code, solution_code, required_concepts_json, max_score, sharing_scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, owner, input.courseId, input.unitId ?? null, input.rubricId ?? null, input.type, txt(input.titleZh), txt(input.titleEn) || null, txt(input.promptZh), txt(input.promptEn) || null, options === null ? null : JSON.stringify(options), jsonString(input.answerKeyJson, "answerKeyJson"), txt(input.explanationZh) || null, txt(input.explanationEn) || null, input.starterCode ?? null, input.solutionCode ?? null, jsonString(input.requiredConceptsJson, "requiredConceptsJson"), input.maxScore ?? 1, input.sharingScope ?? "private"]);
    audit(this.db, actor.id, "question.created", "question", id, "success", { courseId: input.courseId, type: input.type });
    return this.question(id);
  }
  updateQuestion(actor: Actor, id: string, input: Partial<{ titleZh: string; titleEn: string; promptZh: string; promptEn: string; optionsJson: unknown; answerKeyJson: unknown; explanationZh: string; explanationEn: string; starterCode: string; solutionCode: string; requiredConceptsJson: unknown; maxScore: number; sharingScope: "private" | "course" | "school"; status: "draft" | "published" | "archived" }>) {
    const current = requireRow(this.question(id), "Question not found");
    this.manage(actor, current.course_id);
    this.validate({ type: current.type, titleZh: input.titleZh ?? current.title_zh, promptZh: input.promptZh ?? current.prompt_zh, optionsJson: input.optionsJson ?? current.options_json, starterCode: input.starterCode ?? current.starter_code, maxScore: input.maxScore ?? current.max_score });
    const status = input.status ?? current.status;
    this.db.run("UPDATE questions SET title_zh = ?, title_en = ?, prompt_zh = ?, prompt_en = ?, options_json = ?, answer_key_json = ?, explanation_zh = ?, explanation_en = ?, starter_code = ?, solution_code = ?, required_concepts_json = ?, max_score = ?, sharing_scope = ?, status = ?, updated_at = ? WHERE id = ?", [txt(input.titleZh) || current.title_zh, txt(input.titleEn) || current.title_en, txt(input.promptZh) || current.prompt_zh, txt(input.promptEn) || current.prompt_en, input.optionsJson === undefined ? current.options_json : jsonString(input.optionsJson, "optionsJson"), input.answerKeyJson === undefined ? current.answer_key_json : jsonString(input.answerKeyJson, "answerKeyJson"), txt(input.explanationZh) || current.explanation_zh, txt(input.explanationEn) || current.explanation_en, input.starterCode ?? current.starter_code, input.solutionCode ?? current.solution_code, input.requiredConceptsJson === undefined ? current.required_concepts_json : jsonString(input.requiredConceptsJson, "requiredConceptsJson"), input.maxScore ?? current.max_score, input.sharingScope ?? current.sharing_scope, status, now(this.clock), id]);
    audit(this.db, actor.id, "question.updated", "question", id, "success", { status });
    return this.question(id);
  }
  archiveQuestion(actor: Actor, id: string) {
    const current = requireRow(this.db.get<{ course_id: string }>("SELECT course_id FROM questions WHERE id = ?", [id]), "Question not found");
    this.manage(actor, current.course_id);
    const dependent = this.db.get<{ count: number }>("SELECT (SELECT COUNT(*) FROM assignment_items WHERE question_id = ?) + (SELECT COUNT(*) FROM submission_answers WHERE question_id = ?) AS count", [id, id])?.count ?? 0;
    if (dependent > 0) throw new DomainError("dependency_conflict", "Question is referenced by an assignment or submission", 409);
    return this.updateQuestion(actor, id, { status: "archived" });
  }
  addTestCase(actor: Actor, questionId: string, input: { visibility: "public" | "hidden"; label?: string; inputJson?: unknown; expectedOutput: string; comparisonMode?: "exact" | "trimmed" | "numeric_tolerance"; tolerance?: number; weight?: number; position?: number; timeLimitMs?: number; memoryLimitMb?: number }) {
    const question = requireRow(this.question(questionId), "Question not found");
    this.manage(actor, question.course_id);
    if (!["code_fill", "python_code"].includes(question.type)) throw new DomainError("invalid_input", "Test cases are only valid for code questions");
    if (!["public", "hidden"].includes(input.visibility) || !txt(input.expectedOutput)) throw new DomainError("invalid_input", "Test case visibility and expected output are required");
    const id = randomUUID();
    const position = input.position ?? (this.db.get<{ max: number | null }>("SELECT MAX(position) AS max FROM test_cases WHERE question_id = ?", [questionId])?.max ?? -1) + 1;
    this.db.run("INSERT INTO test_cases (id, question_id, visibility, label, input_json, expected_output, comparison_mode, tolerance, weight, position, time_limit_ms, memory_limit_mb) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, questionId, input.visibility, txt(input.label) || null, jsonString(input.inputJson, "inputJson"), input.expectedOutput, input.comparisonMode ?? "trimmed", input.tolerance ?? null, input.weight ?? 1, position, input.timeLimitMs ?? null, input.memoryLimitMb ?? null]);
    return this.db.get("SELECT * FROM test_cases WHERE id = ?", [id]);
  }
  createRubric(actor: Actor, input: { courseId?: string; titleZh: string; titleEn?: string }) {
    requireStaff(actor);
    if (input.courseId) this.manage(actor, input.courseId);
    const owner = actor.role === "teacher" ? actor.id : input.courseId ? this.db.get<{ owner_teacher_id: string }>("SELECT owner_teacher_id FROM courses WHERE id = ?", [input.courseId])?.owner_teacher_id : actor.id;
    const id = randomUUID();
    this.db.run("INSERT INTO rubrics (id, owner_teacher_id, course_id, title_zh, title_en) VALUES (?, ?, ?, ?, ?)", [id, owner, input.courseId ?? null, txt(input.titleZh), txt(input.titleEn) || null]);
    return this.db.get("SELECT * FROM rubrics WHERE id = ?", [id]);
  }
  addRubricCriteria(actor: Actor, rubricId: string, input: { labelZh: string; labelEn?: string; descriptionZh?: string; descriptionEn?: string; weightPercent: number; maxScore: number; position?: number }) {
    const rubric = requireRow(this.db.get<{ owner_teacher_id: string }>("SELECT owner_teacher_id FROM rubrics WHERE id = ?", [rubricId]), "Rubric not found");
    if (actor.role !== "admin" && rubric.owner_teacher_id !== actor.id) throw new DomainError("forbidden", "You cannot manage this rubric", 403);
    if (input.weightPercent < 0 || input.weightPercent > 100 || input.maxScore < 0) throw new DomainError("invalid_input", "Rubric values are out of range");
    const id = randomUUID();
    this.db.run("INSERT INTO rubric_criteria (id, rubric_id, label_zh, label_en, description_zh, description_en, weight_percent, max_score, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, rubricId, txt(input.labelZh), txt(input.labelEn) || null, txt(input.descriptionZh) || null, txt(input.descriptionEn) || null, input.weightPercent, input.maxScore, input.position ?? 0]);
    return this.db.get("SELECT * FROM rubric_criteria WHERE id = ?", [id]);
  }
  activateRubric(actor: Actor, rubricId: string) {
    const rubric = requireRow(this.db.get<{ owner_teacher_id: string }>("SELECT owner_teacher_id FROM rubrics WHERE id = ?", [rubricId]), "Rubric not found");
    if (actor.role !== "admin" && rubric.owner_teacher_id !== actor.id) throw new DomainError("forbidden", "You cannot manage this rubric", 403);
    const total = this.db.get<{ total: number }>("SELECT COALESCE(SUM(weight_percent), 0) AS total FROM rubric_criteria WHERE rubric_id = ?", [rubricId])?.total ?? 0;
    if (Math.abs(total - 100) > 0.001) throw new DomainError("invalid_rubric", "Active rubric criteria must total 100 percent");
    this.db.run("UPDATE rubrics SET status = 'active', updated_at = ? WHERE id = ?", [now(this.clock), rubricId]);
    return this.db.get("SELECT * FROM rubrics WHERE id = ?", [rubricId]);
  }
  private maxHintLayers() {
    return this.db.get<{ value: number }>("SELECT max_hint_layers AS value FROM ai_settings WHERE id = 'global'")?.value ?? 3;
  }
  private validateHintContent(level: number, content: string, source: "manual" | "ai") {
    if (!Number.isInteger(level) || level < 1 || level > this.maxHintLayers()) throw new DomainError("invalid_hint_level", "Hint level exceeds the school policy", 400);
    if (!txt(content) || content.length > 4000) throw new DomainError("invalid_input", "Hint content is required and must be concise", 400);
    if (source === "ai" && level >= 3 && /```|完整答案|完整解答|final answer|complete solution/i.test(content)) throw new DomainError("unsafe_hint_content", "AI hint drafts must not contain a complete answer", 400);
  }
  saveHint(actor: Actor, questionId: string, input: { level: number; contentZh: string; contentEn?: string; source?: "manual" | "ai" }) {
    const question = requireRow(this.question(questionId), "Question not found");
    this.manage(actor, question.course_id);
    const source = input.source === "ai" ? "ai" : "manual";
    this.validateHintContent(input.level, input.contentZh, source);
    if (input.contentEn) this.validateHintContent(input.level, input.contentEn, source);
    const existing = this.db.get<{ id: string; source: string; status: string }>("SELECT id, source, status FROM question_hints WHERE question_id = ? AND level = ?", [questionId, input.level]);
    if (existing && this.db.get("SELECT 1 FROM student_hint_unlocks WHERE hint_id = ?", [existing.id])) throw new DomainError("hint_immutable", "An unlocked hint cannot be changed", 409);
    if (existing?.status === "approved" && source === "ai") throw new DomainError("hint_immutable", "An approved hint cannot be replaced by an AI draft", 409);
    const id = existing?.id ?? randomUUID();
    const status = source === "ai" ? "draft" : "approved";
    const time = now(this.clock);
    this.db.run("INSERT INTO question_hints (id, question_id, level, content_zh, content_en, source, status, created_by_id, reviewed_by_id, reviewed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(question_id, level) DO UPDATE SET content_zh = excluded.content_zh, content_en = excluded.content_en, source = excluded.source, status = excluded.status, reviewed_by_id = excluded.reviewed_by_id, reviewed_at = excluded.reviewed_at, updated_at = excluded.updated_at", [id, questionId, input.level, txt(input.contentZh), txt(input.contentEn) || null, source, status, actor.id, source === "manual" ? actor.id : null, source === "manual" ? time : null, time, time]);
    audit(this.db, actor.id, "question.hint_saved", "question_hint", id, "success", { questionId, level: input.level, source, status });
    return this.db.get("SELECT * FROM question_hints WHERE id = ?", [id]);
  }
  reviewHint(actor: Actor, hintId: string, decision: "approved" | "rejected") {
    const hint = requireRow<Record<string, any>>(this.db.get("SELECT h.*, q.course_id FROM question_hints h JOIN questions q ON q.id = h.question_id JOIN courses c ON c.id = q.course_id WHERE h.id = ? AND c.status != 'archived'", [hintId]), "Question hint not found");
    this.manage(actor, hint.course_id);
    if (hint.source !== "ai" || hint.status !== "draft") throw new DomainError("invalid_review_transition", "Only AI hint drafts can be reviewed", 409);
    if (decision === "approved") this.validateHintContent(hint.level, hint.content_zh, "ai");
    const time = now(this.clock);
    this.db.run("UPDATE question_hints SET status = ?, reviewed_by_id = ?, reviewed_at = ?, updated_at = ? WHERE id = ?", [decision, actor.id, time, time, hintId]);
    audit(this.db, actor.id, "question.hint_reviewed", "question_hint", hintId, "success", { decision });
    return this.db.get("SELECT * FROM question_hints WHERE id = ?", [hintId]);
  }
  deleteHint(actor: Actor, questionId: string, level: number) {
    const question = requireRow(this.question(questionId), "Question not found");
    this.manage(actor, question.course_id);
    const hint = requireRow<Record<string, any>>(this.db.get("SELECT * FROM question_hints WHERE question_id = ? AND level = ?", [questionId, level]), "Question hint not found");
    if (this.db.get("SELECT 1 FROM student_hint_unlocks WHERE hint_id = ?", [hint.id])) throw new DomainError("dependency_conflict", "An unlocked hint cannot be removed", 409);
    this.db.run("DELETE FROM question_hints WHERE id = ?", [hint.id]);
    audit(this.db, actor.id, "question.hint_deleted", "question_hint", hint.id, "success", { questionId, level });
    return { id: hint.id, questionId, level };
  }
  listHints(actor: Actor, questionId: string) {
    const question = requireRow(this.question(questionId), "Question not found");
    this.manage(actor, question.course_id);
    return { maxHintLayers: this.maxHintLayers(), hints: this.db.all("SELECT id, question_id, level, content_zh, content_en, source, status, reviewed_by_id, reviewed_at, created_at, updated_at FROM question_hints WHERE question_id = ? ORDER BY level", [questionId]) };
  }
  studentHintState(actor: Actor, submissionId: string, questionId: string) {
    if (actor.role !== "student") throw new DomainError("forbidden", "Student permission required", 403);
    const answer = this.db.get<Record<string, any>>("SELECT s.student_id, s.status, a.ai_assistant_enabled FROM submissions s JOIN submission_answers sa ON sa.submission_id = s.id JOIN assignments a ON a.id = s.assignment_id JOIN questions q ON q.id = sa.question_id AND q.course_id = a.course_id JOIN courses c ON c.id = a.course_id JOIN course_enrollments ce ON ce.course_id = c.id AND ce.student_id = s.student_id WHERE s.id = ? AND sa.question_id = ? AND s.student_id = ? AND ce.status = 'active' AND c.status = 'published' AND a.status IN ('published', 'closed') AND (a.publish_at IS NULL OR a.publish_at <= ?)", [submissionId, questionId, actor.id, now(this.clock)]);
    if (!answer || answer.student_id !== actor.id) throw new DomainError("not_found", "Submission question not found", 404);
    const unlocked = this.db.all("SELECT u.level, u.source, u.unlocked_at, h.content_zh, h.content_en FROM student_hint_unlocks u JOIN question_hints h ON h.id = u.hint_id AND h.status = 'approved' WHERE u.student_id = ? AND u.submission_id = ? AND u.question_id = ? ORDER BY u.level", [actor.id, submissionId, questionId]);
    const approvedLevels = this.db.all<{ level: number }>("SELECT level FROM question_hints WHERE question_id = ? AND status = 'approved' AND level <= ? ORDER BY level", [questionId, this.maxHintLayers()]);
    let contiguous = 0;
    for (const item of approvedLevels) { if (item.level !== contiguous + 1) break; contiguous = item.level; }
    return { enabled: Boolean(answer.ai_assistant_enabled), hintLevel: unlocked.length, maxHintLevel: contiguous, hints: unlocked };
  }
  unlockNextHint(actor: Actor, submissionId: string, questionId: string, idempotencyKey: string) {
    if (!idempotencyKey.trim() || idempotencyKey.length > 128) throw new DomainError("invalid_input", "Idempotency key is required", 400);
    const state = this.studentHintState(actor, submissionId, questionId);
    if (!state.enabled) throw new DomainError("ai_disabled", "Hints are disabled for this assignment", 503);
    const replay = this.db.get("SELECT id FROM student_hint_unlocks WHERE student_id = ? AND idempotency_key = ?", [actor.id, idempotencyKey]);
    if (replay) return { ...this.studentHintState(actor, submissionId, questionId), replay: true };
    const nextLevel = state.hintLevel + 1;
    if (nextLevel > state.maxHintLevel) throw new DomainError("no_hint_available", "No further approved hint is available", 404);
    const hint = requireRow<Record<string, any>>(this.db.get("SELECT * FROM question_hints WHERE question_id = ? AND level = ? AND status = 'approved'", [questionId, nextLevel]), "Approved hint not found");
    try {
      this.db.run("INSERT INTO student_hint_unlocks (id, student_id, submission_id, question_id, hint_id, level, source, idempotency_key, unlocked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [randomUUID(), actor.id, submissionId, questionId, hint.id, nextLevel, hint.source, idempotencyKey, now(this.clock)]);
    } catch {
      const concurrent = this.studentHintState(actor, submissionId, questionId);
      if (concurrent.hintLevel >= nextLevel) return { ...concurrent, replay: true };
      throw new DomainError("conflict", "Hint unlock conflicted; retry with the same key", 409);
    }
    audit(this.db, actor.id, "question.hint_unlocked", "question_hint", hint.id, "success", { submissionId, questionId, level: nextLevel, source: hint.source });
    return { ...this.studentHintState(actor, submissionId, questionId), replay: false };
  }
  listStudentQuestion(actor: Actor, questionId: string) {
    const question = requireRow(this.question(questionId), "Question not found");
    if (question.status !== "published" || !canViewCourse(this.db, actor, question.course_id)) throw new DomainError("not_found", "Question not found", 404);
    if (question.unit_id && !this.db.get("SELECT 1 FROM units WHERE id = ? AND course_id = ? AND status = 'published'", [question.unit_id, question.course_id])) throw new DomainError("not_found", "Question not found", 404);
    const tests = this.db.all<Record<string, unknown>>("SELECT id, label, visibility, input_json, expected_output, comparison_mode, tolerance, position FROM test_cases WHERE question_id = ? AND visibility = 'public' ORDER BY position", [questionId]);
    return { id: question.id, type: question.type, titleZh: question.title_zh, titleEn: question.title_en, promptZh: question.prompt_zh, promptEn: question.prompt_en, options: jsonValue(question.options_json, "optionsJson"), starterCode: question.starter_code, requiredConcepts: jsonValue(question.required_concepts_json, "requiredConceptsJson"), maxScore: question.max_score, testCases: tests.map((item) => ({ id: item.id, label: item.label, visibility: item.visibility, inputJson: jsonValue(item.input_json, "inputJson"), expectedOutput: item.expected_output, comparisonMode: item.comparison_mode, tolerance: item.tolerance, position: item.position })) };
  }
  listStaffQuestions(actor: Actor, courseId: string) {
    this.manage(actor, courseId);
    return this.db.all("SELECT id, course_id, unit_id, rubric_id, type, title_zh, title_en, prompt_zh, prompt_en, starter_code, required_concepts_json, max_score, sharing_scope, status, created_at, updated_at FROM questions WHERE course_id = ? AND status != 'archived' ORDER BY created_at DESC", [courseId]);
  }
  getStaffQuestion(actor: Actor, questionId: string) {
    const question = requireRow(this.question(questionId), "Question not found");
    if (question.status === "archived" || !canManageCourse(this.db, actor, question.course_id)) throw new DomainError("not_found", "Question not found", 404);
    return question;
  }
}

function snapshotQuestion(db: LocalDatabase, questionId: string, scoreOverride: number | null, position: number) {
  const question = requireRow<Record<string, any>>(db.get("SELECT * FROM questions WHERE id = ?", [questionId]), "Question not found");
  const tests = db.all<Record<string, unknown>>("SELECT * FROM test_cases WHERE question_id = ? ORDER BY position, id", [questionId]);
  return {
    id: question.id,
    type: question.type,
    titleZh: question.title_zh,
    titleEn: question.title_en,
    promptZh: question.prompt_zh,
    promptEn: question.prompt_en,
    optionsJson: jsonValue(question.options_json, "optionsJson"),
    answerKeyJson: jsonValue(question.answer_key_json, "answerKeyJson"),
    explanationZh: question.explanation_zh,
    explanationEn: question.explanation_en,
    starterCode: question.starter_code,
    solutionCode: question.solution_code,
    requiredConceptsJson: jsonValue(question.required_concepts_json, "requiredConceptsJson"),
    maxScore: scoreOverride ?? question.max_score,
    sourceMaxScore: question.max_score,
    position,
    testCases: tests.map((item) => ({
      id: item.id,
      visibility: item.visibility,
      label: item.label,
      inputJson: jsonValue(item.input_json, "inputJson"),
      expectedOutput: item.expected_output,
      comparisonMode: item.comparison_mode,
      tolerance: item.tolerance,
      weight: item.weight,
      position: item.position,
      timeLimitMs: item.time_limit_ms,
      memoryLimitMb: item.memory_limit_mb,
    })),
  };
}

export class AssignmentService {
  private readonly clock: Clock;
  private readonly db: LocalDatabase;
  constructor(db: LocalDatabase, clock: Clock = () => new Date()) { this.db = db; this.clock = clock; }

  private assignment(id: string) {
    return this.db.get<Record<string, any>>("SELECT * FROM assignments WHERE id = ?", [id]);
  }

  private manage(actor: Actor, courseId: string) {
    requireStaff(actor);
    if (!canViewActiveCourse(this.db, actor, courseId) || !canManageCourse(this.db, actor, courseId)) throw new DomainError("not_found", "Course not found", 404);
  }

  private studentAssignment(actor: Actor, assignmentId: string) {
    if (actor.role !== "student") throw new DomainError("forbidden", "Student permission required", 403);
    const assignment = requireRow(this.assignment(assignmentId), "Assignment not found");
    if (!canViewActiveCourse(this.db, actor, assignment.course_id)) throw new DomainError("not_found", "Assignment not found", 404);
    if (assignment.unit_id && !this.db.get("SELECT 1 FROM units WHERE id = ? AND course_id = ? AND status = 'published'", [assignment.unit_id, assignment.course_id])) throw new DomainError("not_found", "Assignment not found", 404);
    const current = this.clock();
    if (assignment.status !== "published") throw new DomainError("not_found", "Assignment not found", 404);
    const publishAt = parseTime(assignment.publish_at);
    if (publishAt && publishAt.getTime() > current.getTime()) throw new DomainError("assignment_unavailable", "Assignment is not available yet");
    return assignment;
  }

  createAssignment(actor: Actor, input: { courseId: string; unitId?: string; kind?: "practice" | "homework" | "quiz" | "exam"; titleZh: string; titleEn?: string; instructionsZh?: string; instructionsEn?: string; publishAt?: string; dueAt?: string; answerReleaseAt?: string; maxAttempts?: number; allowLate?: boolean; allowResubmit?: boolean; randomizeOrder?: boolean; questionSelectionCount?: number; showScoreImmediately?: boolean; showTestResultsImmediately?: boolean; aiAssistantEnabled?: boolean }) {
    this.manage(actor, input.courseId);
    if (!txt(input.titleZh)) throw new DomainError("invalid_input", "Assignment title is required");
    if (input.unitId) {
      const unit = requireRow<{ course_id: string }>(this.db.get("SELECT course_id FROM units WHERE id = ?", [input.unitId]), "Unit not found");
      if (unit.course_id !== input.courseId) throw new DomainError("invalid_reference", "Assignment unit and course must match");
    }
    const maxAttempts = input.maxAttempts ?? 1;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new DomainError("invalid_input", "Maximum attempts must be positive");
    if (input.questionSelectionCount !== undefined && (!Number.isInteger(input.questionSelectionCount) || input.questionSelectionCount < 1)) throw new DomainError("invalid_input", "Question selection count must be positive");
    if (input.publishAt && !parseTime(input.publishAt)) throw new DomainError("invalid_input", "Invalid publish time");
    if (input.dueAt && !parseTime(input.dueAt)) throw new DomainError("invalid_input", "Invalid due time");
    if (input.answerReleaseAt && !parseTime(input.answerReleaseAt)) throw new DomainError("invalid_input", "Invalid answer release time");
    if (input.publishAt && input.dueAt && parseTime(input.dueAt)!.getTime() < parseTime(input.publishAt)!.getTime()) throw new DomainError("invalid_input", "Due time must not precede publish time");
    const id = randomUUID();
    this.db.run("INSERT INTO assignments (id, course_id, unit_id, created_by_id, kind, title_zh, title_en, instructions_zh, instructions_en, publish_at, due_at, answer_release_at, max_attempts, allow_late, allow_resubmit, randomize_order, question_selection_count, show_score_immediately, show_test_results_immediately, ai_assistant_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, input.courseId, input.unitId ?? null, actor.id, input.kind ?? "homework", txt(input.titleZh), txt(input.titleEn) || null, txt(input.instructionsZh) || null, txt(input.instructionsEn) || null, input.publishAt ?? null, input.dueAt ?? null, input.answerReleaseAt ?? null, maxAttempts, input.allowLate ? 1 : 0, input.allowResubmit ? 1 : 0, input.randomizeOrder ? 1 : 0, input.questionSelectionCount ?? null, input.showScoreImmediately === false ? 0 : 1, input.showTestResultsImmediately === false ? 0 : 1, input.aiAssistantEnabled === false ? 0 : 1]);
    audit(this.db, actor.id, "assignment.created", "assignment", id, "success", { courseId: input.courseId });
    return this.assignment(id);
  }

  addQuestion(actor: Actor, assignmentId: string, questionId: string, position?: number, scoreOverride?: number) {
    const assignment = requireRow(this.assignment(assignmentId), "Assignment not found");
    this.manage(actor, assignment.course_id);
    const question = requireRow<Record<string, any>>(this.db.get("SELECT * FROM questions WHERE id = ?", [questionId]), "Question not found");
    if (question.course_id !== assignment.course_id) throw new DomainError("invalid_reference", "Question and assignment must belong to the same course");
    if (scoreOverride !== undefined && scoreOverride < 0) throw new DomainError("invalid_input", "Score override must be nonnegative");
    const nextPosition = position ?? (this.db.get<{ max: number | null }>("SELECT MAX(position) AS max FROM assignment_items WHERE assignment_id = ?", [assignmentId])?.max ?? -1) + 1;
    try { this.db.run("INSERT INTO assignment_items (assignment_id, question_id, course_id, position, score_override) VALUES (?, ?, ?, ?, ?)", [assignmentId, questionId, assignment.course_id, nextPosition, scoreOverride ?? null]); }
    catch { throw new DomainError("conflict", "Question is already in this assignment or position is occupied", 409); }
    return this.db.get("SELECT * FROM assignment_items WHERE assignment_id = ? AND question_id = ?", [assignmentId, questionId]);
  }

  removeQuestion(actor: Actor, assignmentId: string, questionId: string) {
    const assignment = requireRow(this.assignment(assignmentId), "Assignment not found");
    this.manage(actor, assignment.course_id);
    const submissions = this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM submissions WHERE assignment_id = ?", [assignmentId])?.count ?? 0;
    if (submissions > 0) throw new DomainError("dependency_conflict", "Submitted attempts prevent changing assignment questions", 409);
    requireRow(this.db.get("SELECT * FROM assignment_items WHERE assignment_id = ? AND question_id = ?", [assignmentId, questionId]), "Assignment question not found");
    this.db.transaction(() => {
      this.db.run("DELETE FROM assignment_items WHERE assignment_id = ? AND question_id = ?", [assignmentId, questionId]);
      // SQLite enforces the (assignment_id, position) unique index row by row.
      // Move the remaining rows out of the live range first so removing an
      // interior item cannot transiently collide with the row that follows it.
      const remaining = this.db.all<{ question_id: string }>("SELECT question_id FROM assignment_items WHERE assignment_id = ? ORDER BY position, question_id", [assignmentId]);
      this.db.run("UPDATE assignment_items SET position = position + 100000 WHERE assignment_id = ?", [assignmentId]);
      for (const [position, row] of remaining.entries()) {
        this.db.run("UPDATE assignment_items SET position = ? WHERE assignment_id = ? AND question_id = ?", [position, assignmentId, row.question_id]);
      }
    });
    return this.itemRows(assignmentId);
  }

  reorderQuestions(actor: Actor, assignmentId: string, items: Array<{ questionId: string; position: number; scoreOverride?: number | null }>) {
    const assignment = requireRow(this.assignment(assignmentId), "Assignment not found");
    this.manage(actor, assignment.course_id);
    if (this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM submissions WHERE assignment_id = ?", [assignmentId])?.count) throw new DomainError("dependency_conflict", "Submitted attempts prevent reordering", 409);
    const current = this.itemRows(assignmentId);
    if (items.length !== current.length || new Set(items.map((item) => item.questionId)).size !== current.length || items.some((item) => !Number.isInteger(item.position) || item.position < 0 || item.position >= current.length)) throw new DomainError("invalid_input", "Assignment item order must contain each question exactly once");
    this.db.transaction(() => {
      this.db.run("UPDATE assignment_items SET position = position + 100000 WHERE assignment_id = ?", [assignmentId]);
      for (const item of items) this.db.run("UPDATE assignment_items SET position = ?, score_override = ? WHERE assignment_id = ? AND question_id = ?", [item.position, item.scoreOverride ?? null, assignmentId, item.questionId]);
    });
    return this.itemRows(assignmentId);
  }

  listAssignmentQuestions(actor: Actor, assignmentId: string) {
    const assignment = requireRow(this.assignment(assignmentId), "Assignment not found");
    this.manage(actor, assignment.course_id);
    const items = this.db.all<Record<string, any>>("SELECT ai.*, q.title_zh, q.title_en, q.type, q.max_score FROM assignment_items ai JOIN questions q ON q.id = ai.question_id WHERE ai.assignment_id = ? ORDER BY ai.position", [assignmentId]);
    return { items, totalScore: items.reduce((sum, item) => sum + Number(item.score_override ?? item.max_score ?? 0), 0) };
  }

  updateAssignment(actor: Actor, assignmentId: string, input: Partial<{ titleZh: string; titleEn: string; instructionsZh: string; instructionsEn: string; publishAt: string | null; dueAt: string | null; answerReleaseAt: string | null; maxAttempts: number; allowLate: boolean; allowResubmit: boolean; randomizeOrder: boolean; questionSelectionCount: number | null; showScoreImmediately: boolean; showTestResultsImmediately: boolean; aiAssistantEnabled: boolean; status: "draft" | "scheduled" | "published" | "closed" | "archived" }>) {
    const assignment = requireRow(this.assignment(assignmentId), "Assignment not found");
    this.manage(actor, assignment.course_id);
    const status = input.status ?? assignment.status;
    if (status === "published" && (this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM assignment_items WHERE assignment_id = ?", [assignmentId])?.count ?? 0) === 0) throw new DomainError("invalid_assignment", "A published assignment must contain at least one question");
    const maxAttempts = input.maxAttempts ?? assignment.max_attempts;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new DomainError("invalid_input", "Maximum attempts must be positive");
    const publishAt = Object.hasOwn(input, "publishAt") ? input.publishAt ?? null : assignment.publish_at;
    const dueAt = Object.hasOwn(input, "dueAt") ? input.dueAt ?? null : assignment.due_at;
    const answerReleaseAt = Object.hasOwn(input, "answerReleaseAt") ? input.answerReleaseAt ?? null : assignment.answer_release_at;
    if (publishAt && !parseTime(publishAt)) throw new DomainError("invalid_input", "Invalid publish time");
    if (dueAt && !parseTime(dueAt)) throw new DomainError("invalid_input", "Invalid due time");
    if (answerReleaseAt && !parseTime(answerReleaseAt)) throw new DomainError("invalid_input", "Invalid answer release time");
    if (publishAt && dueAt && parseTime(dueAt)!.getTime() < parseTime(publishAt)!.getTime()) throw new DomainError("invalid_input", "Due time must not precede publish time");
    const itemCount = this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM assignment_items WHERE assignment_id = ?", [assignmentId])?.count ?? 0;
    const selectionCount = input.questionSelectionCount === undefined ? assignment.question_selection_count : input.questionSelectionCount;
    if (selectionCount !== null && (!Number.isInteger(selectionCount) || selectionCount < 1 || selectionCount > itemCount)) throw new DomainError("invalid_input", "Question selection count must fit the assignment question count");
    this.db.run("UPDATE assignments SET title_zh = ?, title_en = ?, instructions_zh = ?, instructions_en = ?, publish_at = ?, due_at = ?, answer_release_at = ?, max_attempts = ?, allow_late = ?, allow_resubmit = ?, randomize_order = ?, question_selection_count = ?, show_score_immediately = ?, show_test_results_immediately = ?, ai_assistant_enabled = ?, status = ?, updated_at = ? WHERE id = ?", [txt(input.titleZh) || assignment.title_zh, txt(input.titleEn) || assignment.title_en, txt(input.instructionsZh) || assignment.instructions_zh, txt(input.instructionsEn) || assignment.instructions_en, publishAt, dueAt, answerReleaseAt, maxAttempts, input.allowLate === undefined ? assignment.allow_late : input.allowLate ? 1 : 0, input.allowResubmit === undefined ? assignment.allow_resubmit : input.allowResubmit ? 1 : 0, input.randomizeOrder === undefined ? assignment.randomize_order : input.randomizeOrder ? 1 : 0, input.questionSelectionCount === undefined ? assignment.question_selection_count : input.questionSelectionCount, input.showScoreImmediately === undefined ? assignment.show_score_immediately : input.showScoreImmediately ? 1 : 0, input.showTestResultsImmediately === undefined ? assignment.show_test_results_immediately : input.showTestResultsImmediately ? 1 : 0, input.aiAssistantEnabled === undefined ? assignment.ai_assistant_enabled : input.aiAssistantEnabled ? 1 : 0, status, now(this.clock), assignmentId]);
    audit(this.db, actor.id, "assignment.updated", "assignment", assignmentId, "success", { status });
    return this.assignment(assignmentId);
  }

  archiveAssignment(actor: Actor, assignmentId: string) {
    const assignment = requireRow(this.assignment(assignmentId), "Assignment not found");
    this.manage(actor, assignment.course_id);
    const submissions = this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM submissions WHERE assignment_id = ?", [assignmentId])?.count ?? 0;
    if (submissions > 0) throw new DomainError("dependency_conflict", "Submissions prevent archiving this assignment", 409);
    return this.updateAssignment(actor, assignmentId, { status: "archived" });
  }

  listAssignments(actor: Actor, courseId: string) {
    if (!canViewActiveCourse(this.db, actor, courseId)) throw new DomainError("not_found", "Course not found", 404);
    if (actor.role === "student") {
      const current = now(this.clock);
      return this.db.all(`SELECT a.id, a.course_id, a.unit_id, a.kind, a.title_zh, a.title_en, a.instructions_zh, a.instructions_en,
        a.publish_at, a.due_at, a.answer_release_at, a.max_attempts, a.allow_late, a.allow_resubmit, a.randomize_order,
        a.question_selection_count, a.show_score_immediately, a.show_test_results_immediately, a.ai_assistant_enabled, a.status,
        CASE WHEN a.status = 'closed' THEN 'closed'
          WHEN a.due_at IS NOT NULL AND datetime(a.due_at) < datetime(?) THEN 'past_due'
          WHEN a.due_at IS NULL THEN 'no_due'
          ELSE 'upcoming' END AS reminder_state,
        CASE WHEN a.status = 'closed' THEN 0
          WHEN a.due_at IS NOT NULL AND datetime(a.due_at) < datetime(?) AND a.allow_late = 0 THEN 0
          ELSE 1 END AS can_start
        FROM assignments a LEFT JOIN units u ON u.id = a.unit_id
        WHERE a.course_id = ? AND a.status IN ('published', 'closed') AND (a.publish_at IS NULL OR a.publish_at <= ?)
          AND (a.unit_id IS NULL OR u.status = 'published')
        ORDER BY CASE WHEN a.due_at IS NULL THEN 1 ELSE 0 END, datetime(a.due_at) ASC, a.id ASC`, [current, current, courseId, current]);
    }
    return this.db.all("SELECT * FROM assignments WHERE course_id = ? AND status != 'archived' ORDER BY created_at", [courseId]);
  }

  getAssignment(actor: Actor, assignmentId: string) {
    const assignment = requireRow(this.assignment(assignmentId), "Assignment not found");
    if (actor.role === "student") return this.studentAssignment(actor, assignmentId);
    this.manage(actor, assignment.course_id);
    return assignment;
  }

  private itemRows(assignmentId: string) {
    return this.db.all<Record<string, any>>("SELECT ai.assignment_id, ai.question_id, ai.course_id, ai.position, ai.score_override FROM assignment_items ai WHERE ai.assignment_id = ? ORDER BY ai.position, ai.question_id", [assignmentId]);
  }

  private submissionView(actor: Actor, submissionId: string) {
    const submission = requireRow<Record<string, any>>(this.db.get("SELECT s.*, a.course_id, a.show_score_immediately, a.show_test_results_immediately, a.answer_release_at, g.auto_score AS grade_auto_score, g.teacher_adjusted_score, g.final_score AS grade_final_score, g.max_score AS grade_max_score, g.status AS grade_status, g.released_at AS grade_released_at FROM submissions s JOIN assignments a ON a.id = s.assignment_id LEFT JOIN grades g ON g.submission_id = s.id WHERE s.id = ?", [submissionId]), "Submission not found");
    if (actor.role === "student" && submission.student_id !== actor.id) throw new DomainError("forbidden", "You cannot view this submission", 403);
    if (actor.role === "student") this.studentAssignment(actor, submission.assignment_id);
    if (STAFF.has(actor.role) && !canManageCourse(this.db, actor, submission.course_id)) throw new DomainError("forbidden", "You cannot view this submission", 403);
    const answers = this.db.all<Record<string, any>>("SELECT * FROM submission_answers WHERE submission_id = ? ORDER BY position, question_id", [submissionId]);
    const student = actor.role === "student";
    const answersReleased = Boolean(submission.answer_release_at && (parseTime(submission.answer_release_at)?.getTime() ?? Number.POSITIVE_INFINITY) <= this.clock().getTime());
    const gradeReleased = submission.grade_status === "released";
    const scoreReleased = Boolean(submission.show_score_immediately || gradeReleased || answersReleased);
    const testResultsReleased = Boolean(submission.show_test_results_immediately || gradeReleased || answersReleased);
    return {
      ...submission,
      scoreReleased,
      testResultsReleased,
      answersReleased,
      totalScore: scoreReleased ? submission.grade_final_score ?? answers.reduce((sum, answer) => sum + Number(answer.final_score ?? 0), 0) : null,
      maxScore: submission.grade_max_score ?? answers.reduce((sum, answer) => sum + Number(JSON.parse(answer.question_snapshot_json).maxScore ?? 0), 0),
      gradeStatus: submission.grade_status ?? "not_created",
      answers: answers.map((answer) => student ? {
        id: answer.id, questionId: answer.question_id, position: answer.position,
        answerText: answer.answer_text, answerJson: answer.answer_json, fileAssetId: answer.file_asset_id,
        autoScore: scoreReleased ? answer.auto_score : null, finalScore: scoreReleased ? answer.final_score : null,
        teacherFeedback: gradeReleased ? answer.teacher_feedback : null,
        question: safeStudentQuestionProjection(answer, answersReleased),
      } : answer),
    };
  }

  beginSubmission(actor: Actor, assignmentId: string) {
    const assignment = this.studentAssignment(actor, assignmentId);
    assertAssignmentSubmissionOpen(this.db, assignmentId);
    const existing = this.db.get<{ id: string }>("SELECT id FROM submissions WHERE assignment_id = ? AND student_id = ? AND status = 'draft' ORDER BY attempt_number DESC LIMIT 1", [assignmentId, actor.id]);
    if (existing) return this.submissionView(actor, existing.id);
    const latest = this.db.get<{ attempt_number: number }>("SELECT MAX(attempt_number) AS attempt_number FROM submissions WHERE assignment_id = ? AND student_id = ?", [assignmentId, actor.id])?.attempt_number ?? 0;
    if (latest >= assignment.max_attempts || (latest > 0 && !assignment.allow_resubmit)) throw new DomainError("attempt_limit", "No submission attempts remain");
    const items = this.itemRows(assignmentId);
    if (items.length === 0) throw new DomainError("invalid_assignment", "Assignment has no questions");
    const selected = items.slice();
    if (assignment.randomize_order) {
      for (let i = selected.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [selected[i], selected[j]] = [selected[j], selected[i]];
      }
    }
    const count = assignment.question_selection_count ? Math.min(assignment.question_selection_count, selected.length) : selected.length;
    const chosen = selected.slice(0, count);
    const submissionId = randomUUID();
    const attemptNumber = latest + 1;
    const current = this.clock();
    const due = parseTime(assignment.due_at);
    const isLate = Boolean(due && current.getTime() > due.getTime());
    if (isLate && !assignment.allow_late) throw new DomainError("assignment_closed", "The assignment deadline has passed");
    try {
      this.db.transaction(() => {
        this.db.run("INSERT INTO submissions (id, assignment_id, student_id, attempt_number, is_late, last_activity_at) VALUES (?, ?, ?, ?, ?, ?)", [submissionId, assignmentId, actor.id, attemptNumber, isLate ? 1 : 0, now(this.clock)]);
        chosen.forEach((item, position) => {
          const snapshot = snapshotQuestion(this.db, item.question_id, item.score_override, position);
          this.db.run("INSERT INTO submission_answers (id, submission_id, assignment_id, student_id, question_id, question_snapshot_json, position) VALUES (?, ?, ?, ?, ?, ?, ?)", [randomUUID(), submissionId, assignmentId, actor.id, item.question_id, JSON.stringify(snapshot), position]);
        });
      });
    } catch (error) {
      const raced = this.db.get<{ id: string }>("SELECT id FROM submissions WHERE assignment_id = ? AND student_id = ? AND status = 'draft' ORDER BY attempt_number DESC LIMIT 1", [assignmentId, actor.id]);
      if (raced) return this.submissionView(actor, raced.id);
      throw error;
    }
    audit(this.db, actor.id, "submission.started", "submission", submissionId, "success", { assignmentId, attemptNumber, questionCount: chosen.length });
    return this.submissionView(actor, submissionId);
  }

  saveAnswer(actor: Actor, submissionId: string, questionId: string, input: { answerText?: string; answerJson?: unknown; fileAssetId?: string | null }) {
    const submission = requireRow<Record<string, any>>(this.db.get("SELECT * FROM submissions WHERE id = ?", [submissionId]), "Submission not found");
    if (actor.role !== "student" || submission.student_id !== actor.id) throw new DomainError("forbidden", "You cannot edit this submission", 403);
    if (submission.status !== "draft") throw new DomainError("submission_locked", "Submitted work cannot be changed");
    this.studentAssignment(actor, submission.assignment_id);
    assertAssignmentSubmissionOpen(this.db, submission.assignment_id);
    const answer = requireRow(this.db.get("SELECT id FROM submission_answers WHERE submission_id = ? AND question_id = ?", [submissionId, questionId]), "Question is not in this submission");
    if (input.fileAssetId) {
      const asset = this.db.get<{ uploaded_by_id: string | null; status: string }>("SELECT uploaded_by_id, status FROM file_assets WHERE id = ?", [input.fileAssetId]);
      if (!asset || asset.status !== "ready") throw new DomainError("file_not_ready", "Answer file must be released before submission");
      if (asset.uploaded_by_id !== actor.id) throw new DomainError("forbidden", "You cannot submit this file", 403);
    }
    this.db.run("UPDATE submission_answers SET answer_text = ?, answer_json = ?, file_asset_id = ?, updated_at = ? WHERE id = ?", [input.answerText ?? null, input.answerJson === undefined ? null : jsonString(input.answerJson, "answerJson"), input.fileAssetId ?? null, now(this.clock), answer.id]);
    this.db.run("UPDATE submissions SET last_activity_at = ? WHERE id = ?", [now(this.clock), submissionId]);
    return this.submissionView(actor, submissionId);
  }

  submit(actor: Actor, submissionId: string) {
    const submission = requireRow<Record<string, any>>(this.db.get("SELECT s.*, a.course_id, a.due_at, a.allow_late FROM submissions s JOIN assignments a ON a.id = s.assignment_id WHERE s.id = ?", [submissionId]), "Submission not found");
    if (actor.role !== "student" || submission.student_id !== actor.id) throw new DomainError("forbidden", "You cannot submit this work", 403);
    if (submission.status !== "draft") return this.submissionView(actor, submissionId);
    this.studentAssignment(actor, submission.assignment_id);
    assertAssignmentSubmissionOpen(this.db, submission.assignment_id);
    const due = parseTime(submission.due_at);
    const isLate = Boolean(due && this.clock().getTime() > due.getTime());
    if (isLate && !submission.allow_late) throw new DomainError("assignment_closed", "The assignment deadline has passed");
    const submittedAt = now(this.clock);
    this.db.transaction(() => {
      this.db.run("UPDATE submissions SET status = 'submitted', submitted_at = ?, is_late = ?, last_activity_at = ? WHERE id = ?", [submittedAt, isLate ? 1 : 0, submittedAt, submissionId]);
      const maxScore = this.db.get<{ total: number }>("SELECT COALESCE(SUM(json_extract(question_snapshot_json, '$.maxScore')), 0) AS total FROM submission_answers WHERE submission_id = ?", [submissionId])?.total ?? 0;
      this.db.run("INSERT INTO grades (id, submission_id, max_score, status) VALUES (?, ?, ?, 'pending') ON CONFLICT(submission_id) DO NOTHING", [randomUUID(), submissionId, maxScore]);
    });
    audit(this.db, actor.id, "submission.submitted", "submission", submissionId, "success", { isLate });
    return this.submissionView(actor, submissionId);
  }

  grade(actor: Actor, submissionId: string, input: { questionId: string; score: number; feedback?: string }) {
    const submission = requireRow<Record<string, any>>(this.db.get("SELECT s.*, a.course_id FROM submissions s JOIN assignments a ON a.id = s.assignment_id WHERE s.id = ?", [submissionId]), "Submission not found");
    this.manage(actor, submission.course_id);
    if (!Number.isFinite(input.score) || input.score < 0) throw new DomainError("invalid_input", "Score must be nonnegative");
    const answer = requireRow<Record<string, any>>(this.db.get("SELECT * FROM submission_answers WHERE submission_id = ? AND question_id = ?", [submissionId, input.questionId]), "Question is not in this submission");
    const snapshot = JSON.parse(answer.question_snapshot_json) as Record<string, any>;
    if (input.score > Number(snapshot.maxScore)) throw new DomainError("invalid_input", "Score exceeds question maximum");
    this.db.transaction(() => {
      this.db.run("UPDATE submission_answers SET teacher_score = ?, final_score = ?, teacher_feedback = ?, review_status = 'confirmed', reviewed_by_id = ?, reviewed_at = ?, updated_at = ? WHERE id = ?", [input.score, input.score, input.feedback ?? null, actor.id, now(this.clock), now(this.clock), answer.id]);
      const total = this.db.get<{ total: number }>("SELECT COALESCE(SUM(final_score), 0) AS total FROM submission_answers WHERE submission_id = ?", [submissionId])?.total ?? 0;
      this.db.run("UPDATE grades SET teacher_adjusted_score = ?, final_score = ?, status = 'confirmed', graded_by_id = ?, graded_at = ? WHERE submission_id = ?", [total, total, actor.id, now(this.clock), submissionId]);
      this.db.run("UPDATE submissions SET status = 'graded', last_activity_at = ? WHERE id = ?", [now(this.clock), submissionId]);
    });
    return this.submissionView(actor, submissionId);
  }

  releaseGrade(actor: Actor, submissionId: string) {
    const submission = requireRow<Record<string, any>>(this.db.get("SELECT s.*, a.course_id FROM submissions s JOIN assignments a ON a.id = s.assignment_id WHERE s.id = ?", [submissionId]), "Submission not found");
    this.manage(actor, submission.course_id);
    const grade = requireRow<{ status: string }>(this.db.get("SELECT status FROM grades WHERE submission_id = ?", [submissionId]), "Grade not found");
    if (!["confirmed", "review_required", "released"].includes(grade.status)) throw new DomainError("grade_not_ready", "Grade must be confirmed before release", 409);
    this.db.run("UPDATE grades SET status = 'released', released_at = ?, updated_at = ? WHERE submission_id = ?", [now(this.clock), now(this.clock), submissionId]);
    return this.db.get("SELECT * FROM grades WHERE submission_id = ?", [submissionId]);
  }

  getSubmission(actor: Actor, submissionId: string) { return this.submissionView(actor, submissionId); }
  listSubmissions(actor: Actor, assignmentId: string) {
    const assignment = requireRow(this.assignment(assignmentId), "Assignment not found");
    this.manage(actor, assignment.course_id);
    return this.db.all("SELECT s.id, s.assignment_id, s.student_id, s.attempt_number, s.status, s.is_late, s.submitted_at, s.last_activity_at, g.final_score, g.max_score, g.status AS grade_status FROM submissions s LEFT JOIN grades g ON g.submission_id = s.id WHERE s.assignment_id = ? ORDER BY s.submitted_at DESC, s.created_at DESC", [assignmentId]);
  }
}
