import { createServer, type IncomingMessage } from "node:http";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { assertDatabaseIntegrity, openLocalDatabase, type LocalDatabase } from "../db.ts";
import { DomainError, asDomainError } from "../errors.ts";
import { EducationService, type Actor } from "../education.ts";
import { handleEducationApi } from "../education-api.ts";
import { LocalFileStorage } from "../storage.ts";
import { MaterialService, QuestionService, AssignmentService } from "../content.ts";
import { ExecutionService, HttpRunnerClient, type RunnerClient } from "../execution.ts";
import { ClassroomService } from "../classroom/service.ts";
import { NotificationService, type Mailer } from "../notifications/service.ts";
import { SmtpMailer } from "../notifications/smtp.ts";
import { AnalyticsService } from "../analytics/service.ts";
import { ExportService } from "../exports/service.ts";
import { BackupService } from "../backups/service.ts";
import { AiAdminService, AiService, ConfiguredAiProvider, MasterKeyCipher, type AiProvider } from "../ai.ts";
import { AiReviewService } from "../ai.ts";
import { AuditService } from "../audit/service.ts";
import { allowedMethodsForPath } from "./route-manifest.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
// A 25 MiB binary becomes roughly 33.4 MiB when transported as base64 JSON.
// The decoded-byte limit remains enforced by LocalFileStorage.
const MAX_REQUEST_BYTES = 36 * 1024 * 1024;
const MIN_INTERNAL_TOKEN_LENGTH = 24;
const LEGACY_AI_SUNSET = "Sun, 28 Feb 2027 00:00:00 GMT";

function legacyHeaders(requestId: string, successor: string) {
  return {
    "x-request-id": requestId,
    "deprecation": "true",
    "sunset": LEGACY_AI_SUNSET,
    "link": `<${successor}>; rel="successor-version"`,
  };
}

export type BackendOptions = {
  databasePath?: string;
  storageRoot?: string;
  exportRoot?: string;
  backupRoot?: string;
  runner?: RunnerClient;
  runnerUrl?: string;
  runnerToken?: string;
  internalToken?: string;
  production?: boolean;
  csrfRequired?: boolean;
  aiMasterKey?: string;
  aiProvider?: AiProvider;
  emailEnabled?: boolean;
  mailer?: Mailer;
  logger?: (event: Record<string, unknown>) => void;
};

export type BackendServices = {
  db: LocalDatabase;
  education: EducationService;
  materials: MaterialService;
  questions: QuestionService;
  assignments: AssignmentService;
  execution: ExecutionService;
  classroom: ClassroomService;
  notifications: NotificationService;
  analytics: AnalyticsService;
  exports: ExportService;
  backups: BackupService;
  ai: AiService;
  aiAdmin: AiAdminService;
  aiReview: AiReviewService;
  audit: AuditService;
};

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(data, { status, headers: { ...JSON_HEADERS, ...headers } });
}
function parts(pathname: string) {
  return pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean);
}
function parseCookie(request: Request, name: string) {
  return (request.headers.get("cookie") ?? "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"))?.[1] ?? null;
}
async function input(request: Request) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_REQUEST_BYTES) throw new DomainError("request_too_large", "Request body is too large", 413);
  try { return await request.json() as Record<string, unknown>; } catch { throw new DomainError("invalid_json", "Request body must be valid JSON", 400); }
}
function actorOf(request: Request, education: EducationService): Actor & { user: unknown; sessionId: string } {
  const token = parseCookie(request, "session");
  if (!token) throw new DomainError("unauthorized", "Authentication required", 401);
  return education.session(decodeURIComponent(token));
}
function assertPasswordReady(actor: Actor & { user: unknown; sessionId: string }) {
  if ((actor.user as { mustChangePassword?: boolean }).mustChangePassword) {
    throw new DomainError("password_change_required", "Password change is required before accessing this resource", 428);
  }
  return actor;
}
function staff(actor: Actor) {
  if (actor.role !== "admin" && actor.role !== "teacher") throw new DomainError("forbidden", "Staff permission required", 403);
}
function id(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim() || value.length > 128) throw new DomainError("invalid_input", name + " is required", 400);
  return value;
}
function decodeBase64(value: unknown) {
  const encoded = String(value ?? "");
  if (!encoded || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new DomainError("invalid_base64", "File content must be valid base64", 400);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new DomainError("invalid_base64", "File content must be canonical base64", 400);
  return bytes;
}
function attachmentHeader(filename: string) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\\r\n]/g, "_") || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename.replace(/[\r\n]/g, "_"))}`;
}
function safeError(error: unknown, requestId?: string) {
  const e = asDomainError(error);
  return json({ error: { code: e.code, message: e.message } }, e.status, requestId ? { "x-request-id": requestId } : {});
}
function safeLogText(value: unknown) {
  return String(value ?? "")
    .replace(/(bearer|token|password|cookie|api[_-]?key|secret)\s*[:=]?\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/[A-Za-z]:\\(?:[^\s\\]+\\)*[^\s\\]+/g, "[path]")
    .replace(/\/(?:[^\s/]+\/)+[^\s,;:)\]]+/g, "[path]")
    .slice(0, 2000);
}
function educationPath(request: Request, path: string) {
  const original = new URL(request.url);
  const mapped = new URL("/api/education/" + path, original);
  mapped.search = original.search;
  return new Request(mapped, request);
}
function withSecureCookie(response: Response, production: boolean) {
  const headers = new Headers(response.headers);
  const value = headers.get("set-cookie");
  if (value && production && !/;\s*Secure/i.test(value)) headers.set("set-cookie", value + "; Secure");
  return new Response(response.body, { status: response.status, headers });
}

export function createBackendApp(options: BackendOptions = {}) {
  const production = options.production ?? process.env.NODE_ENV === "production";
  const csrfRequired = options.csrfRequired !== false;
  const internalToken = options.internalToken ?? process.env.BACKEND_INTERNAL_TOKEN ?? "";
  if (production && internalToken.length < MIN_INTERNAL_TOKEN_LENGTH) {
    throw new Error("BACKEND_INTERNAL_TOKEN must be configured with at least 24 characters in production");
  }
  const db = openLocalDatabase(options.databasePath ?? process.env.DATABASE_PATH ?? ":memory:");
  const storageRoot = options.storageRoot ?? process.env.STORAGE_ROOT ?? ".data/storage";
  const exportRoot = options.exportRoot ?? process.env.EXPORT_STORAGE_ROOT ?? ".data/exports";
  const backupRoot = options.backupRoot ?? process.env.BACKUP_ROOT ?? ".data/backups";
  mkdirSync(storageRoot, { recursive: true });
  mkdirSync(exportRoot, { recursive: true });
  mkdirSync(backupRoot, { recursive: true });
  const storage = new LocalFileStorage(storageRoot, Number(process.env.MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024));
  const education = new EducationService(db);
  const runner = options.runner ?? new HttpRunnerClient(options.runnerUrl ?? process.env.PYTHON_RUNNER_URL ?? "http://runner:8080", options.runnerToken ?? process.env.PYTHON_RUNNER_TOKEN ?? "");
  const masterCipher = options.aiMasterKey || process.env.AI_MASTER_KEY ? new MasterKeyCipher(options.aiMasterKey || process.env.AI_MASTER_KEY) : null;
  const aiAdmin = new AiAdminService(db, masterCipher);
  const smtpMailer = options.mailer ?? new SmtpMailer(process.env.SMTP_HOST ? {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    tlsMode: process.env.SMTP_TLS_MODE === "tls" || process.env.SMTP_TLS_MODE === "starttls" ? process.env.SMTP_TLS_MODE : "none",
    username: process.env.SMTP_USERNAME || undefined,
    password: process.env.SMTP_PASSWORD || undefined,
    from: process.env.EMAIL_FROM ?? "python-learning@example.invalid",
    timeoutMs: Number(process.env.SMTP_TIMEOUT_MS ?? 10000),
  } : undefined);
  const services: BackendServices = {
    db, education, materials: new MaterialService(db, storage), questions: new QuestionService(db), assignments: new AssignmentService(db),
    execution: new ExecutionService(db, runner), classroom: new ClassroomService(db), notifications: new NotificationService(db, undefined, { mailer: smtpMailer, emailEnabled: options.emailEnabled ?? process.env.EMAIL_ENABLED === "true", secretCipher: masterCipher }),
    analytics: new AnalyticsService(db), exports: new ExportService(db, exportRoot),
    backups: new BackupService(db, { databasePath: options.databasePath ?? process.env.DATABASE_PATH ?? ":memory:", sourceStorageRoot: storageRoot, backupRoot, enabled: process.env.BACKUP_ENABLED === "true" }),
    ai: new AiService(db, options.aiProvider ?? new ConfiguredAiProvider(db, aiAdmin)), aiAdmin, aiReview: new AiReviewService(db), audit: new AuditService(db),
  };
  const logger = options.logger ?? ((event: Record<string, unknown>) => console.error(JSON.stringify(event)));

  async function handle(request: Request): Promise<Response> {
    const requestId = request.headers.get("x-request-id")?.slice(0, 128) || randomUUID();
    let stage = "request";
    let actorId: string | null = null;
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health" || url.pathname === "/ready") {
        const integrity = assertDatabaseIntegrity(db);
        return json({ status: "ok", database: integrity.integrity, foreignKeys: integrity.foreignKeys, storage: "configured" }, 200, { "x-request-id": requestId });
      }
      if (!url.pathname.startsWith("/api/v1/")) return safeError(new DomainError("not_found", "API endpoint not found", 404), requestId);
      if (internalToken && request.headers.get("x-backend-token") !== internalToken) return safeError(new DomainError("unauthorized", "Backend authentication required", 401), requestId);
      if (csrfRequired && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        const origin = request.headers.get("origin");
        if (!origin || origin !== url.origin) return safeError(new DomainError("csrf_failed", "Same-origin request required", 403), requestId);
      }
      const p = parts(url.pathname);
      const method = request.method.toUpperCase();
      const contractPath = "/" + p.join("/");
      const allowed = allowedMethodsForPath(contractPath);
      if (allowed && !allowed.includes(method as never)) {
        return json({ error: { code: "method_not_allowed", message: "HTTP method is not supported for this endpoint" } }, 405, { "allow": allowed.join(", "), "x-request-id": requestId });
      }
      const educationRoute = p[0] === "auth" || p[0] === "me" || p[0] === "students" || p[0] === "users" || p[0] === "classes" ||
        (p[0] === "units" && p.length === 2) || (p[0] === "courses" && (p.length <= 2 || p[1] === "join" || p[2] === "classes"));
      const passwordOpenRoute = p[0] === "me" || (p[0] === "auth" && ["login", "logout", "password", "change-password"].includes(p[1] ?? ""));
      if (educationRoute) {
        if (!passwordOpenRoute) assertPasswordReady(actorOf(request, education));
        const mapped = p.join("/") === "auth/change-password" ? "auth/password" : p.join("/");
        const response = await handleEducationApi(educationPath(request, mapped), { service: education });
        const secured = withSecureCookie(response, production);
        secured.headers.set("x-request-id", requestId);
        if (method === "PUT" && ["classes", "courses", "units"].includes(p[0] ?? "") && p.length === 2) {
          for (const [name, value] of Object.entries(legacyHeaders(requestId, `/api/v1/${p[0]}/${p[1]}`))) secured.headers.set(name, value);
        }
        return secured;
      }
      const actor = assertPasswordReady(actorOf(request, education));
      actorId = actor.id;
      if (method === "POST" && p[0] === "admin" && p[1] === "users" && p.length === 2) {
        if (actor.role !== "admin") throw new DomainError("forbidden", "Administrator permission required", 403);
        const b = await input(request);
        return json(education.createUser(actor, { role: b.role as "teacher" | "student", username: String(b.username ?? ""), chineseName: String(b.chineseName ?? ""), englishName: b.englishName ? String(b.englishName) : undefined, email: b.email ? String(b.email) : undefined, studentNumber: b.studentNumber ? String(b.studentNumber) : undefined }), 201, { "x-request-id": requestId });
      }
      if (method === "GET" && p[0] === "courses" && p[2] === "units" && p.length === 3) return json({ units: education.listUnits(actor, id(p[1], "courseId")) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "courses" && p[2] === "units" && p.length === 3) {
        const b = await input(request);
        return json({ unit: education.createUnit(actor, id(p[1], "courseId"), { titleZh: String(b.titleZh ?? ""), titleEn: b.titleEn ? String(b.titleEn) : undefined, descriptionZh: b.descriptionZh ? String(b.descriptionZh) : undefined, descriptionEn: b.descriptionEn ? String(b.descriptionEn) : undefined, position: typeof b.position === "number" ? b.position : undefined }) }, 201, { "x-request-id": requestId });
      }
      if (method === "GET" && p[0] === "courses" && p[2] === "assignments" && p.length === 3) return json({ assignments: services.assignments.listAssignments(actor, id(p[1], "courseId")) }, 200, { "x-request-id": requestId });
      if (method === "GET" && p[0] === "courses" && p[2] === "questions" && p.length === 3) return json({ questions: services.questions.listStaffQuestions(actor, id(p[1], "courseId")) }, 200, { "x-request-id": requestId });
      if (method === "GET" && p[0] === "assignments" && p[2] === "submissions" && p.length === 3) return json({ submissions: services.assignments.listSubmissions(actor, id(p[1], "assignmentId")) }, 200, { "x-request-id": requestId });
      if (method === "GET" && p[0] === "courses" && p[2] === "classrooms" && p.length === 3) return json({ sessions: services.classroom.listSessions(actor, id(p[1], "courseId")) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "classrooms" && p[2] === "join" && p.length === 3) return json({ classroom: services.classroom.joinSession(actor, id(p[1], "sessionId")) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "classrooms" && p[2] === "heartbeat" && p.length === 3) return json({ classroom: services.classroom.heartbeat(actor, id(p[1], "sessionId")) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "classrooms" && p[2] === "end" && p.length === 3) {
        const b = await input(request);
        return json({ classroom: services.classroom.endSession(actor, id(p[1], "sessionId"), String(b.idempotencyKey ?? requestId)) }, 200, { "x-request-id": requestId });
      }
      if (method === "GET" && p[0] === "classrooms" && p[2] === "events" && p.length === 3) {
        const since = Number(url.searchParams.get("since") ?? 0);
        if (!Number.isSafeInteger(since) || since < 0) throw new DomainError("invalid_input", "since must be a nonnegative integer", 400);
        return json(services.classroom.eventsSince(actor, id(p[1], "sessionId"), since), 200, { "x-request-id": requestId });
      }
      if (method === "GET" && p[0] === "classrooms" && p.length === 2) return json({ classroom: services.classroom.getSession(actor, id(p[1], "sessionId")) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "classrooms" && p.length === 1) {
        const b = await input(request);
        return json({ classroom: services.classroom.createSession(actor, { courseId: id(b.courseId, "courseId"), title: String(b.title ?? "") }) }, 201, { "x-request-id": requestId });
      }
      if (method === "POST" && p[0] === "classrooms" && p[2] === "activities" && p.length === 3) return json({ activity: services.classroom.createActivity(actor, id(p[1], "sessionId"), (await input(request)) as never) }, 201, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "activities" && p[2] === "transition" && p.length === 3) {
        const b = await input(request);
        const transition = ["start", "pause", "lock", "reopen", "end"].includes(String(b.transition)) ? String(b.transition) : "start";
        return json({ classroom: services.classroom.transitionActivity(actor, id(p[1], "activityId"), transition as never, String(b.idempotencyKey ?? requestId)) }, 200, { "x-request-id": requestId });
      }
      if (method === "GET" && p[0] === "units" && p[2] === "materials" && p.length === 3) return json({ materials: await services.materials.listMaterials(actor, id(p[1], "unitId")) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "units" && p[2] === "materials" && p.length === 3) {
        stage = "material_create";
        const b = await input(request);
        return json({ material: await services.materials.createMaterial(actor, id(p[1], "unitId"), { kind: String(b.kind ?? "web_content"), titleZh: String(b.titleZh ?? ""), titleEn: b.titleEn ? String(b.titleEn) : undefined, bodyZh: b.bodyZh ? String(b.bodyZh) : undefined, bodyEn: b.bodyEn ? String(b.bodyEn) : undefined, fileAssetId: b.fileAssetId ? String(b.fileAssetId) : undefined, sourceUrl: b.sourceUrl ? String(b.sourceUrl) : undefined, allowDownload: b.allowDownload === undefined ? undefined : Boolean(b.allowDownload), position: typeof b.position === "number" ? b.position : undefined, bindingMode: b.bindingMode === "copy" ? "copy" : "reference" }) }, 201, { "x-request-id": requestId });
      }
      if (method === "PATCH" && p[0] === "materials" && p.length === 2) {
        const b = await input(request);
        return json({ material: services.materials.updateMaterial(actor, id(p[1], "materialId"), b as never) }, 200, { "x-request-id": requestId });
      }
      if (method === "DELETE" && p[0] === "materials" && p.length === 2) return json({ material: await services.materials.archiveMaterial(actor, id(p[1], "materialId")) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "materials" && p[2] === "upgrade-asset" && p.length === 3) {
        stage = "material_asset_upgrade";
        const b = await input(request);
        return json({ material: services.materials.upgradeMaterialAsset(actor, id(p[1], "materialId"), b.assetId ? id(b.assetId, "assetId") : undefined) }, 200, { "x-request-id": requestId });
      }
      if (method === "POST" && p[0] === "materials" && p[2] === "conversion" && p.length === 3) {
        const b = await input(request);
        return json({ job: services.materials.createConversionJob(actor, id(p[1], "materialId"), b.kind === "document_preview" ? "document_preview" : "ppt_to_web") }, 202, { "x-request-id": requestId });
      }
      if (method === "GET" && p[0] === "materials" && p[2] === "conversion" && p.length === 3) return json({ job: services.materials.getConversionStatus(actor, id(p[1], "materialId")) }, 200, { "x-request-id": requestId });
      if (method === "GET" && p[0] === "materials" && p[2] === "preview" && p.length === 3) return json({ preview: services.materials.previewManifest(actor, id(p[1], "materialId")) }, 200, { "x-request-id": requestId });
      if (method === "GET" && p[0] === "materials" && p[2] === "preview" && p[3] === "pdf" && p.length === 4) {
        const result = await services.materials.downloadPreviewPdf(actor, id(p[1], "materialId"));
        return new Response(result.bytes, { headers: { "content-type": result.mimeType, "content-disposition": attachmentHeader(result.filename).replace(/^attachment/, "inline"), "cache-control": "private, no-store", "x-content-type-options": "nosniff", "x-request-id": requestId } });
      }
      if (method === "GET" && p[0] === "materials" && p[2] === "preview" && p[3] === "slides" && p.length === 5) {
        const page = Number(p[4]);
        const result = await services.materials.downloadPreviewSlide(actor, id(p[1], "materialId"), page);
        return new Response(result.bytes, { headers: { "content-type": result.mimeType, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "x-request-id": requestId } });
      }
      if (method === "GET" && p[0] === "materials" && p[2] === "download" && p.length === 3) {
        const result = await services.materials.downloadMaterial(actor, id(p[1], "materialId"));
        return new Response(result.bytes, { headers: { "content-type": result.mimeType, "content-disposition": attachmentHeader(result.filename), "cache-control": "no-store", "x-content-type-options": "nosniff", "x-request-id": requestId } });
      }
      if (method === "POST" && p[0] === "files" && p[2] === "release" && p.length === 3) return json({ asset: await services.materials.releaseUpload(actor, id(p[1], "assetId")) }, 200, { "x-request-id": requestId });
      if (method === "GET" && p[0] === "files" && p.length === 1) {
        if (new URL(request.url).searchParams.get("scope") !== "available") throw new DomainError("invalid_input", "Only the available library scope is supported", 400);
        return json({ assets: services.materials.listAvailableLibraryAssets(actor) }, 200, { "x-request-id": requestId });
      }
      if (method === "PATCH" && p[0] === "files" && p.length === 2) {
        const b = await input(request);
        return json({ asset: services.materials.updateLibraryScope(actor, id(p[1], "assetId"), String(b.libraryScope ?? "") as "private" | "school") }, 200, { "x-request-id": requestId });
      }
      if (method === "DELETE" && p[0] === "files" && p.length === 2) return json({ asset: await services.materials.deleteFileAsset(actor, id(p[1], "assetId")) }, 200, { "x-request-id": requestId });
      if (method === "GET" && p[0] === "files" && p[2] === "download" && p.length === 3) {
        const result = await services.materials.downloadLibraryAsset(actor, id(p[1], "assetId"));
        return new Response(result.bytes, { headers: { "content-type": result.mimeType, "content-disposition": attachmentHeader(result.filename), "cache-control": "no-store", "x-content-type-options": "nosniff", "x-request-id": requestId } });
      }
      if (method === "POST" && p[0] === "files" && p.length === 1) {
        stage = "file_quarantine";
        const b = await input(request);
        const bytes = decodeBase64(b.contentBase64);
        if (bytes.byteLength > MAX_REQUEST_BYTES) throw new DomainError("file_too_large", "File exceeds request limit", 413);
        return json({ asset: await services.materials.quarantineUpload(actor, { originalName: String(b.originalName ?? ""), mimeType: String(b.mimeType ?? ""), bytes, purpose: b.purpose ? String(b.purpose) as never : undefined, libraryScope: b.libraryScope ? String(b.libraryScope) as never : undefined, previousAssetId: b.previousAssetId ? id(b.previousAssetId, "previousAssetId") : undefined }) }, 201, { "x-request-id": requestId });
      }
      if (method === "POST" && p[0] === "questions" && p.length === 1) {
        const b = await input(request);
        return json({ question: services.questions.createQuestion(actor, { ...b, courseId: id(b.courseId, "courseId"), type: String(b.type ?? ""), titleZh: String(b.titleZh ?? ""), promptZh: String(b.promptZh ?? "") } as never) }, 201, { "x-request-id": requestId });
      }
      if (method === "POST" && p[0] === "rubrics" && p.length === 1) {
        const b = await input(request);
        return json({ rubric: services.questions.createRubric(actor, { courseId: b.courseId ? String(b.courseId) : undefined, titleZh: String(b.titleZh ?? ""), titleEn: b.titleEn ? String(b.titleEn) : undefined }) }, 201, { "x-request-id": requestId });
      }
      if (method === "POST" && p[0] === "rubrics" && p[2] === "criteria" && p.length === 3) {
        const b = await input(request);
        return json({ criterion: services.questions.addRubricCriteria(actor, id(p[1], "rubricId"), { labelZh: String(b.labelZh ?? ""), labelEn: b.labelEn ? String(b.labelEn) : undefined, descriptionZh: b.descriptionZh ? String(b.descriptionZh) : undefined, descriptionEn: b.descriptionEn ? String(b.descriptionEn) : undefined, weightPercent: Number(b.weightPercent), maxScore: Number(b.maxScore), position: typeof b.position === "number" ? b.position : undefined }) }, 201, { "x-request-id": requestId });
      }
      if (method === "POST" && p[0] === "rubrics" && p[2] === "activate" && p.length === 3) return json({ rubric: services.questions.activateRubric(actor, id(p[1], "rubricId")) }, 200, { "x-request-id": requestId });
      if (method === "PATCH" && p[0] === "questions" && p.length === 2) return json({ question: services.questions.updateQuestion(actor, id(p[1], "questionId"), (await input(request)) as never) }, 200, { "x-request-id": requestId });
      if (method === "DELETE" && p[0] === "questions" && p.length === 2) return json({ question: services.questions.archiveQuestion(actor, id(p[1], "questionId")) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "questions" && p[2] === "test-cases" && p.length === 3) return json({ testCase: services.questions.addTestCase(actor, id(p[1], "questionId"), (await input(request)) as never) }, 201, { "x-request-id": requestId });
      if (method === "GET" && p[0] === "questions" && p[2] === "hints" && p.length === 3) return json(services.questions.listHints(actor, id(p[1], "questionId")), 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "questions" && p[2] === "hints" && p.length === 3) return json({ hint: services.questions.saveHint(actor, id(p[1], "questionId"), (await input(request)) as never) }, 201, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "questions" && p[2] === "hints" && p[3] === "generate" && p.length === 4) {
        const b = await input(request);
        const question = services.questions.getStaffQuestion(actor, id(p[1], "questionId"));
        const level = Number(b.level);
        const result = await services.ai.request(actor, { requestKey: id(b.requestKey, "requestKey"), purpose: "question_generation", task: `Create a level ${level} progressive hint. Do not provide the complete answer.`, questionPrompt: String(question.prompt_zh ?? ""), estimatedTokens: typeof b.estimatedTokens === "number" ? b.estimatedTokens : undefined, hintLevel: level });
        if (!result.content) throw new DomainError("provider_failed", "AI provider returned no hint draft", 502);
        return json({ hint: services.questions.saveHint(actor, id(p[1], "questionId"), { level, contentZh: result.content, source: "ai" }) }, 201, { "x-request-id": requestId });
      }
      if (method === "DELETE" && p[0] === "questions" && p[2] === "hints" && p.length === 4) return json({ removed: services.questions.deleteHint(actor, id(p[1], "questionId"), Number(p[3])) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "question-hints" && p[2] === "review" && p.length === 3) {
        const b = await input(request);
        return json({ hint: services.questions.reviewHint(actor, id(p[1], "hintId"), b.decision === "rejected" ? "rejected" : "approved") }, 200, { "x-request-id": requestId });
      }
      if (method === "GET" && p[0] === "questions" && p.length === 2) return json({ question: actor.role === "student" ? services.questions.listStudentQuestion(actor, id(p[1], "questionId")) : services.questions.getStaffQuestion(actor, id(p[1], "questionId")) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "assignments" && p.length === 1) {
        const b = await input(request);
        return json({ assignment: services.assignments.createAssignment(actor, { ...b, courseId: id(b.courseId, "courseId"), titleZh: String(b.titleZh ?? "") } as never) }, 201, { "x-request-id": requestId });
      }
      if (method === "GET" && p[0] === "assignments" && p.length === 2) return json({ assignment: services.assignments.getAssignment(actor, id(p[1], "assignmentId")) }, 200, { "x-request-id": requestId });
      if (method === "PATCH" && p[0] === "assignments" && p.length === 2) return json({ assignment: services.assignments.updateAssignment(actor, id(p[1], "assignmentId"), (await input(request)) as never) }, 200, { "x-request-id": requestId });
      if (method === "DELETE" && p[0] === "assignments" && p.length === 2) return json({ assignment: services.assignments.archiveAssignment(actor, id(p[1], "assignmentId")) }, 200, { "x-request-id": requestId });
      if (method === "GET" && p[0] === "assignments" && p[2] === "questions" && p.length === 3) return json(services.assignments.listAssignmentQuestions(actor, id(p[1], "assignmentId")), 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "assignments" && p[2] === "questions" && p.length === 3) {
        const b = await input(request);
        return json({ item: services.assignments.addQuestion(actor, id(p[1], "assignmentId"), id(b.questionId, "questionId"), typeof b.position === "number" ? b.position : undefined, typeof b.scoreOverride === "number" ? b.scoreOverride : undefined) }, 201, { "x-request-id": requestId });
      }
      if (method === "DELETE" && p[0] === "assignments" && p[2] === "questions" && p.length === 3) {
        const b = await input(request);
        return json({ items: services.assignments.removeQuestion(actor, id(p[1], "assignmentId"), id(b.questionId, "questionId")) }, 200, { "x-request-id": requestId });
      }
      if (method === "PATCH" && p[0] === "assignments" && p[2] === "questions" && p.length === 3) {
        const b = await input(request);
        return json({ items: services.assignments.reorderQuestions(actor, id(p[1], "assignmentId"), Array.isArray(b.items) ? b.items as Array<{ questionId: string; position: number; scoreOverride?: number | null }> : []) }, 200, { "x-request-id": requestId });
      }
      if (method === "POST" && p[0] === "assignments" && p[2] === "submissions" && p.length === 3) return json({ submission: services.assignments.beginSubmission(actor, id(p[1], "assignmentId")) }, 201, { "x-request-id": requestId });
      if (method === "PATCH" && p[0] === "submissions" && p[2] === "answers" && p.length === 4) {
        const b = await input(request);
        return json({ submission: services.assignments.saveAnswer(actor, id(p[1], "submissionId"), id(p[3], "questionId"), b as never) }, 200, { "x-request-id": requestId });
      }
      if (method === "POST" && p[0] === "submissions" && p[2] === "submit" && p.length === 3) return json({ submission: services.assignments.submit(actor, id(p[1], "submissionId")) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "submissions" && p[2] === "grade" && p.length === 3) return json({ submission: services.assignments.grade(actor, id(p[1], "submissionId"), (await input(request)) as never) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "submissions" && p[2] === "release-grade" && p.length === 3) return json({ grade: services.assignments.releaseGrade(actor, id(p[1], "submissionId")) }, 200, { "x-request-id": requestId });
      if (method === "GET" && p[0] === "submissions" && p[2] === "questions" && p[4] === "hints" && p.length === 5) return json({ state: services.questions.studentHintState(actor, id(p[1], "submissionId"), id(p[3], "questionId")) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "submissions" && p[2] === "questions" && p[4] === "hints" && p[5] === "unlock" && p.length === 6) {
        const b = await input(request);
        return json({ state: services.questions.unlockNextHint(actor, id(p[1], "submissionId"), id(p[3], "questionId"), id(b.idempotencyKey, "idempotencyKey")) }, 200, { "x-request-id": requestId });
      }
      if (method === "GET" && p[0] === "submissions" && p.length === 2) return json({ submission: services.assignments.getSubmission(actor, id(p[1], "submissionId")) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "submission-answers" && p[2] === "execute" && p.length === 3) {
        const b = await input(request);
        return json({ execution: await services.execution.execute(actor, id(p[1], "answerId"), String(b.code ?? ""), { stdin: String(b.stdin ?? ""), timeoutMs: typeof b.timeoutMs === "number" ? b.timeoutMs : undefined }) }, 200, { "x-request-id": requestId });
      }
      if (method === "POST" && p[0] === "submission-answers" && p[2] === "grade" && p.length === 3) {
        const b = await input(request);
        return json({ execution: await services.execution.grade(actor, id(p[1], "answerId"), String(b.code ?? ""), { timeoutMs: typeof b.timeoutMs === "number" ? b.timeoutMs : undefined }) }, 200, { "x-request-id": requestId });
      }
      if (method === "POST" && p[0] === "submission-answers" && p[2] === "snapshots" && p.length === 3) {
        const b = await input(request);
        const source = String(b.source ?? "autosave");
        if (!["autosave", "paste"].includes(source)) throw new DomainError("invalid_input", "Snapshot source is invalid", 400);
        return json({ snapshot: services.execution.createCodeSnapshot(actor, id(p[1], "answerId"), String(b.code ?? ""), source as "autosave" | "paste", Number(b.pastedCharacterCount ?? 0)) }, 201, { "x-request-id": requestId });
      }
      if (method === "GET" && p[0] === "courses" && p[2] === "execution-policy" && p.length === 3) return json({ policy: services.execution.getPackagePolicy(actor, id(p[1], "courseId")) }, 200, { "x-request-id": requestId });
      if (method === "PATCH" && p[0] === "courses" && p[2] === "execution-policy" && p.length === 3) {
        const b = await input(request);
        return json({ policy: services.execution.setPackagePolicy(actor, id(p[1], "courseId"), Array.isArray(b.allowedPackages) ? b.allowedPackages as string[] : []) }, 200, { "x-request-id": requestId });
      }
      if (method === "POST" && p[0] === "exports" && p.length === 1) {
        const b = await input(request);
        return json({ job: services.exports.createJob(actor, { reportType: b.reportType as never, format: b.format as never, filters: (b.filters ?? {}) as never, correlationId: requestId }) }, 201, { "x-request-id": requestId });
      }
      if (method === "GET" && p[0] === "exports" && p.length === 1) return json({ jobs: services.exports.listJobs(actor) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "exports" && p[2] === "run" && p.length === 3) return json({ job: await services.exports.runJob(actor, id(p[1], "exportId")) }, 200, { "x-request-id": requestId });
      if (method === "GET" && p[0] === "exports" && p[2] === "download" && p.length === 3) {
        const file = await services.exports.download(actor, id(p[1], "exportId"));
        return new Response(file.bytes, { headers: { "content-type": file.contentType, "content-disposition": 'attachment; filename="' + file.fileName.replace(/["\r\n]/g, "_") + '"', "cache-control": "no-store", "x-request-id": requestId } });
      }
      if (method === "GET" && p[0] === "notifications" && p.length === 1) return json({ notifications: services.notifications.listNotifications(actor) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "announcements" && p[2] === "publish" && p.length === 3) {
        const b = await input(request);
        return json({ announcement: services.notifications.publishAnnouncement(actor, id(p[1], "announcementId"), requestId, { sendEmail: b.sendEmail !== false }) }, 200, { "x-request-id": requestId });
      }
      if (method === "POST" && p[0] === "announcements" && p.length === 1) return json({ announcement: services.notifications.createAnnouncement(actor, (await input(request)) as never) }, 201, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "notifications" && p[2] === "read" && p.length === 3) return json({ notification: services.notifications.markRead(actor, id(p[1], "notificationId")) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "admin" && p[1] === "email" && p[2] === "process" && p.length === 3) {
        if (actor.role !== "admin") throw new DomainError("forbidden", "Administrator permission required", 403);
        return json({ deliveries: await services.notifications.processEmailQueue() }, 200, { "x-request-id": requestId });
      }
      if (method === "GET" && p[0] === "admin" && p[1] === "email" && p[2] === "settings" && p.length === 3) return json({ settings: services.notifications.emailSettings(actor) }, 200, { "x-request-id": requestId });
      if (method === "PATCH" && p[0] === "admin" && p[1] === "email" && p[2] === "settings" && p.length === 3) return json({ settings: services.notifications.configureEmail(actor, (await input(request)) as never) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "admin" && p[1] === "email" && p[3] === "retry" && p.length === 4) return json({ delivery: services.notifications.retryDelivery(actor, id(p[2], "deliveryId")) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "admin" && p[1] === "email" && p[3] === "cancel" && p.length === 4) return json({ delivery: services.notifications.cancelDelivery(actor, id(p[2], "deliveryId")) }, 200, { "x-request-id": requestId });
      if (method === "GET" && p[0] === "admin" && p[1] === "email" && p.length === 2) return json({ deliveries: services.notifications.listDeliveries(actor) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "ai" && p[1] === "conversations" && p.length === 2) {
        const b = await input(request);
        return json({ conversation: services.ai.startConversation(actor, id(b.courseId, "courseId"), b.assignmentId ? String(b.assignmentId) : undefined, b.questionId ? String(b.questionId) : undefined) }, 201, { "x-request-id": requestId });
      }
      if (method === "GET" && p[0] === "ai" && p[1] === "status" && p.length === 2) return json({ status: services.ai.status(actor) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "ai" && p[1] === "request" && p.length === 2) return json({ result: await services.ai.request(actor, (await input(request)) as never) }, 200, { "x-request-id": requestId });
      if (method === "GET" && p[0] === "ai" && p[1] === "conversations" && p.length === 3) return json({ conversation: services.ai.listConversation(actor, id(p[2], "conversationId")) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "ai" && p[1] === "artifacts" && p.length === 2) return json({ artifact: services.aiReview.create(actor, (await input(request)) as never) }, 201, { "x-request-id": requestId });
      if (method === "GET" && p[0] === "ai" && p[1] === "artifacts" && p.length === 3) return json({ artifact: actor.role === "student" ? services.aiReview.getStudent(actor, id(p[2], "artifactId")) : services.aiReview.getStaff(actor, id(p[2], "artifactId")) }, 200, { "x-request-id": requestId });
      if (method === "GET" && p[0] === "courses" && p[2] === "ai-artifacts" && p.length === 3) return json({ artifacts: services.aiReview.listStaff(actor, id(p[1], "courseId")) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "ai" && p[1] === "artifacts" && p[3] === "review" && p.length === 4) {
        const b = await input(request);
        return json({ artifact: services.aiReview.review(actor, id(p[2], "artifactId"), b.decision === "rejected" ? "rejected" : "approved", b.comment ? String(b.comment) : undefined) }, 200, { "x-request-id": requestId });
      }
      if (method === "POST" && p[0] === "ai" && p[1] === "artifacts" && p[3] === "publish" && p.length === 4) return json({ artifact: services.aiReview.publish(actor, id(p[2], "artifactId")) }, 200, { "x-request-id": requestId });
      if (method === "GET" && p[0] === "admin" && p[1] === "ai" && p[2] === "providers" && p.length === 3) return json({ providers: services.aiAdmin.listProviders(actor) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "admin" && p[1] === "ai" && p[2] === "providers" && p.length === 3) return json({ provider: services.aiAdmin.configureProvider(actor, (await input(request)) as never) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "admin" && p[1] === "ai" && p[2] === "providers" && p[4] === "activate" && p.length === 5) return json({ provider: services.aiAdmin.activateProvider(actor, id(p[3], "providerId")) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "admin" && p[1] === "ai" && p[2] === "providers" && p[4] === "disable" && p.length === 5) return json({ provider: services.aiAdmin.disableProvider(actor, id(p[3], "providerId")) }, 200, { "x-request-id": requestId });
      if (method === "GET" && p[0] === "admin" && p[1] === "ai" && p[2] === "settings" && p.length === 3) return json({ settings: services.aiAdmin.getSettings(actor) }, 200, { "x-request-id": requestId });
      if (method === "PATCH" && p[0] === "admin" && p[1] === "ai" && p[2] === "settings" && p.length === 3) return json({ settings: services.aiAdmin.updateSettings(actor, (await input(request)) as never) }, 200, { "x-request-id": requestId });
      // Phase 7 compatibility aliases; new clients use /admin/ai/*.
      if (method === "POST" && p[0] === "admin" && p[1] === "ai-provider" && p.length === 2) return json({ provider: services.aiAdmin.configureProvider(actor, (await input(request)) as never) }, 200, legacyHeaders(requestId, "/api/v1/admin/ai/providers"));
      if (method === "PATCH" && p[0] === "admin" && p[1] === "ai-settings" && p.length === 2) return json({ settings: services.aiAdmin.updateSettings(actor, (await input(request)) as never) }, 200, legacyHeaders(requestId, "/api/v1/admin/ai/settings"));
      if (method === "GET" && p[0] === "analytics" && p.length <= 2) {
        staff(actor);
        const filters = { courseId: url.searchParams.get("courseId") ?? undefined, classId: url.searchParams.get("classId") ?? undefined, studentId: url.searchParams.get("studentId") ?? undefined };
        const reports: Record<string, (a: Actor) => unknown> = {
          overview: (a) => services.analytics.overview(a, filters),
          "question-accuracy": (a) => services.analytics.questionAccuracy(a, filters),
          "common-errors": (a) => services.analytics.commonErrors(a, filters),
          "ai-usage": (a) => services.analytics.aiUsage(a, filters),
          "code-history": (a) => services.analytics.codeHistory(a, filters),
          "learning-time": (a) => services.analytics.learningTime(a, filters),
          "compare-courses": (a) => services.analytics.compareCourses(a, filters),
        };
        const selected = reports[p[1] ?? "overview"];
        if (!selected) throw new DomainError("not_found", "Analytics report not found", 404);
        const report = selected(actor);
        return json(report, 200, { "x-request-id": requestId });
      }
      if (method === "GET" && p[0] === "admin" && p[1] === "audit" && p.length === 2) return json({ logs: services.audit.list(actor, { action: url.searchParams.get("action") ?? undefined, correlationId: url.searchParams.get("correlationId") ?? undefined, limit: Number(url.searchParams.get("limit") ?? 100) }) }, 200, { "x-request-id": requestId });
      if (method === "GET" && p[0] === "admin" && p[1] === "backups" && p.length === 2) return json({ backups: services.backups.list(actor), settings: services.backups.settings(actor) }, 200, { "x-request-id": requestId });
      if (method === "PATCH" && p[0] === "admin" && p[1] === "backups" && p.length === 2) {
        const b = await input(request);
        return json({ settings: services.backups.setEnabled(actor, b.enabled === true) }, 200, { "x-request-id": requestId });
      }
      if (method === "POST" && p[0] === "admin" && p[1] === "backups" && p.length === 4 && p[3] === "verify") return json({ verification: await services.backups.verify(actor, id(p[2], "backupId")) }, 200, { "x-request-id": requestId });
      if (method === "POST" && p[0] === "admin" && p[1] === "backups" && p.length === 2) return json({ backup: await services.backups.create(actor, (await input(request)) as never) }, 202, { "x-request-id": requestId });
      if (method === "GET" && p[0] === "admin" && p[1] === "status" && p.length === 2) {
        if (actor.role !== "admin") throw new DomainError("forbidden", "Administrator permission required", 403);
        return json({ ai: { configured: Boolean(db.get("SELECT 1 FROM ai_provider_configs WHERE enabled = 1")) }, backup: { enabled: services.backups.settings(actor).enabled } }, 200, { "x-request-id": requestId });
      }
      if (allowed) return json({ error: { code: "method_not_allowed", message: "HTTP method is not supported for this endpoint" } }, 405, { "allow": allowed.join(", "), "x-request-id": requestId });
      throw new DomainError("not_found", "API endpoint not found", 404);
    } catch (error) {
      if (!(error instanceof DomainError)) {
        const raw = error instanceof Error ? error : new Error(String(error));
        logger({ level: "error", event: "backend.request_failed", requestId, method: request.method, path: new URL(request.url).pathname, actorId, stage, error: { name: safeLogText(raw.name), message: safeLogText(raw.message), stack: safeLogText(raw.stack) } });
      }
      const response = safeError(error);
      response.headers.set("x-request-id", requestId);
      return response;
    }
  }
  return { services, handle, close: () => db.close() };
}

async function nodeRequest(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new DomainError("request_too_large", "Request body is too large", 413);
    chunks.push(bytes);
  }
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(",") : value);
  return new Request("http://" + (request.headers.host ?? "localhost") + (request.url ?? "/"), { method: request.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, duplex: "half" } as RequestInit);
}
export function createBackendServer(options: BackendOptions = {}) {
  const app = createBackendApp(options);
  const server = createServer(async (req, res) => {
    try {
      const response = await app.handle(await nodeRequest(req));
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      const bytes = new Uint8Array(await response.arrayBuffer());
      res.end(bytes);
    } catch (error) {
      const response = safeError(error);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      res.end(Buffer.from(await response.arrayBuffer()));
    }
  });
  return { app, server };
}
