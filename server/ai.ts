/* eslint-disable @typescript-eslint/no-explicit-any -- SQLite rows are runtime-shaped and provider payloads are intentionally validated at boundaries. */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { Actor } from "./education.ts";
import type { LocalDatabase } from "./db.ts";
import { DomainError } from "./errors.ts";
import { normalizeQuestionConcepts, QuestionService } from "./content.ts";

const STAFF = new Set(["admin", "teacher"]);
const PURPOSES = new Set(["student_hint", "translation", "question_generation", "grading", "summary", "feedback"]);
const ARTIFACT_TYPES = new Set(["material", "translation", "question", "feedback", "suggested_score"]);
const AUTHORING_TYPES = new Set(["multiple_choice", "fill_blank", "short_answer", "code_fill", "python_code", "file_upload", "project_upload"]);
type Clock = () => Date;

function iso(clock: Clock) { return clock().toISOString(); }
function audit(db: LocalDatabase, actorId: string | null, action: string, entityType: string, entityId: string | null, result: "success" | "denied" | "failure", metadata: Record<string, unknown> = {}) {
  db.run("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, result, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)", [randomUUID(), actorId, action, entityType, entityId, result, JSON.stringify(metadata)]);
}
function requireStaff(actor: Actor) {
  if (!STAFF.has(actor.role)) throw new DomainError("forbidden", "Staff permission required", 403);
}
function parseJson(value: unknown, field: string) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { throw new DomainError("invalid_json", field + " must be valid JSON"); }
}
function usageDate(clock: Clock, timezone: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(clock());
    const values = Object.fromEntries(parts.filter((part) => ["year", "month", "day"].includes(part.type)).map((part) => [part.type, part.value]));
    return String(values.year) + "-" + String(values.month) + "-" + String(values.day);
  } catch {
    throw new DomainError("invalid_timezone", "AI timezone is invalid");
  }
}
function canManageCourse(db: LocalDatabase, actor: Actor, courseId: string) {
  const course = db.get<{ status: string }>("SELECT status FROM courses WHERE id = ?", [courseId]);
  if (!course || course.status === "archived") return false;
  if (actor.role === "admin") return true;
  if (actor.role !== "teacher") return false;
  return Boolean(db.get("SELECT 1 FROM courses c WHERE c.id = ? AND (c.owner_teacher_id = ? OR EXISTS (SELECT 1 FROM course_class_assignments cca JOIN class_memberships cm ON cm.class_id = cca.class_id WHERE cca.course_id = c.id AND cm.user_id = ? AND cm.member_role = 'teacher' AND cm.status = 'active'))", [courseId, actor.id, actor.id]));
}
function canViewCourse(db: LocalDatabase, actor: Actor, courseId: string) {
  const course = db.get<{ status: string }>("SELECT status FROM courses WHERE id = ?", [courseId]);
  if (!course || course.status === "archived") return false;
  if (actor.role === "admin") return true;
  if (actor.role === "teacher") return canManageCourse(db, actor, courseId);
  return course.status === "published" && Boolean(db.get("SELECT 1 FROM course_enrollments WHERE course_id = ? AND student_id = ? AND status = 'active'", [courseId, actor.id]));
}

function parseAuthoringJson(content: string) {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, any>;
  } catch {
    throw new DomainError("ai_question_invalid", "AI provider returned invalid question JSON", 502);
  }
}

function parseArtifactJson(content: string) {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, any>;
  } catch {
    throw new DomainError("ai_artifact_invalid", "AI provider returned invalid artifact JSON", 502);
  }
}

function artifactText(value: unknown, field: string, max: number, required = false) {
  if (typeof value !== "string") {
    if (required) throw new DomainError("ai_artifact_invalid", `AI artifact ${field} is required`, 502);
    return null;
  }
  const result = value.trim();
  if (required && !result) throw new DomainError("ai_artifact_invalid", `AI artifact ${field} is required`, 502);
  if (result.length > max) throw new DomainError("ai_artifact_invalid", `AI artifact ${field} is too long`, 502);
  return result || null;
}

function artifactList(value: unknown, field: string, maxItems: number, maxItemLength: number) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new DomainError("ai_artifact_invalid", `AI artifact ${field} is invalid`, 502);
  return value.map((item, index) => artifactText(item, `${field}[${index}]`, maxItemLength, true));
}

function boundedText(value: unknown, field: string, max: number, required = false) {
  if (typeof value !== "string") {
    if (required) throw new DomainError("ai_question_invalid", `AI question ${field} is required`, 502);
    return null;
  }
  const result = value.trim();
  if (required && !result) throw new DomainError("ai_question_invalid", `AI question ${field} is required`, 502);
  if (result.length > max) throw new DomainError("ai_question_invalid", `AI question ${field} is too long`, 502);
  return result || null;
}

export type ProviderMessage = { role: "system" | "user"; content: string };
export type ProviderRequest = { model: string; messages: ProviderMessage[]; temperature?: number };
export type ProviderResponse = { content: string; inputTokens: number; outputTokens: number; model?: string };
export interface AiProvider { generate(request: ProviderRequest): Promise<ProviderResponse>; }

export class FakeAiProvider implements AiProvider {
  readonly calls: ProviderRequest[] = [];
  private readonly responder: (request: ProviderRequest) => Promise<ProviderResponse> | ProviderResponse;
  constructor(responder: (request: ProviderRequest) => Promise<ProviderResponse> | ProviderResponse = async () => ({ content: "fake hint", inputTokens: 10, outputTokens: 5, model: "fake-model" })) { this.responder = responder; }
  async generate(request: ProviderRequest) {
    this.calls.push(request);
    return await this.responder(request);
  }
}

export class OpenAICompatibleProvider implements AiProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetcher: typeof fetch;
  private readonly apiPath: string;
  private readonly timeoutMs: number;
  constructor(baseUrl: string, apiKey: string, model: string, fetcher: typeof fetch = fetch, apiPath = "/chat/completions", timeoutMs = 15000) {
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new DomainError("invalid_provider_url", "AI provider URL must use HTTP(S) without embedded credentials");
    if (!apiPath.startsWith("/") || apiPath.startsWith("//") || apiPath.length > 256) throw new DomainError("invalid_provider_path", "AI provider path is invalid");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new DomainError("invalid_provider_timeout", "AI provider timeout must be between 1000 and 120000 ms");
    this.baseUrl = url.toString().replace(/\/$/, ""); this.apiKey = apiKey; this.model = model; this.fetcher = fetcher; this.apiPath = apiPath; this.timeoutMs = timeoutMs;
  }
  async generate(request: ProviderRequest) {
    if (!this.apiKey.trim()) throw new DomainError("provider_unavailable", "AI provider key is unavailable", 503);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(this.baseUrl + this.apiPath, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + this.apiKey },
        body: JSON.stringify({ model: request.model || this.model, messages: request.messages, temperature: request.temperature ?? 0.2 }),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) throw new DomainError("provider_timeout", "AI provider request timed out", 504);
      throw new DomainError("provider_unreachable", "AI provider could not be reached", 502);
    } finally { clearTimeout(timer); }
    if (!response.ok) {
      if (response.status === 429) throw new DomainError("provider_busy", "AI provider is busy", 429);
      if (response.status >= 500) throw new DomainError("provider_failed", "AI provider request failed", 502);
      if (response.status === 401 || response.status === 403) throw new DomainError("provider_auth_failed", "AI provider rejected its server credential", 502);
      throw new DomainError("provider_failed", "AI provider request failed", 502);
    }
    const payload = await response.json() as Record<string, any>;
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") throw new DomainError("provider_protocol", "AI provider returned an invalid response", 502);
    return { content, inputTokens: Number(payload.usage?.prompt_tokens ?? 0), outputTokens: Number(payload.usage?.completion_tokens ?? 0), model: String(payload.model ?? request.model ?? this.model) };
  }
}

export class MasterKeyCipher {
  private readonly key: Buffer;
  readonly version = 1;
  constructor(masterKey: string | Uint8Array | undefined) {
    if (!masterKey) throw new DomainError("ai_master_key_missing", "AI master key is not configured", 503);
    const raw = typeof masterKey === "string" ? (masterKey.match(/^[0-9a-fA-F]{64}$/) ? Buffer.from(masterKey, "hex") : Buffer.from(masterKey, "base64")) : Buffer.from(masterKey);
    if (raw.length !== 32) throw new DomainError("ai_master_key_invalid", "AI master key must be 32 bytes", 503);
    this.key = raw;
  }
  encrypt(plaintext: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", Buffer.from(iv).toString("base64url"), Buffer.from(cipher.getAuthTag()).toString("base64url"), Buffer.from(ciphertext).toString("base64url")].join(".");
  }
  decrypt(value: string) {
    const [version, ivValue, tagValue, ciphertextValue] = value.split(".");
    if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) throw new DomainError("ai_key_invalid", "AI provider key cannot be decrypted", 503);
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivValue, "base64url"));
      decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      throw new DomainError("ai_key_invalid", "AI provider key cannot be decrypted", 503);
    }
  }
}

export function maskApiKey(value: string) {
  const suffix = value.slice(-4);
  return suffix ? "••••••••" + suffix : "••••••••";
}

export class AiAdminService {
  private readonly clock: Clock;
  private readonly db: LocalDatabase;
  private readonly cipher: MasterKeyCipher | null;
  constructor(db: LocalDatabase, cipher: MasterKeyCipher | null, clock: Clock = () => new Date()) { this.db = db; this.cipher = cipher; this.clock = clock; }
  private assertAdmin(actor: Actor) { if (actor.role !== "admin") throw new DomainError("forbidden", "Administrator permission required", 403); }
  configureProvider(actor: Actor, input: { providerKey: string; displayName: string; apiBaseUrl?: string; apiPath?: string; timeoutMs?: number; defaultModel: string; apiKey: string; enabled?: boolean }) {
    this.assertAdmin(actor);
    if (!input.providerKey.trim() || !input.defaultModel.trim() || !input.apiKey.trim()) throw new DomainError("invalid_input", "Provider, model and API key are required");
    if (!this.cipher) throw new DomainError("ai_master_key_missing", "AI master key is not configured", 503);
    const cipher = this.cipher;
    const apiBaseUrl = input.apiBaseUrl?.trim() || "https://api.openai.com/v1";
    const apiPath = input.apiPath?.trim() || "/chat/completions";
    const timeoutMs = input.timeoutMs ?? 15000;
    // Constructor validation keeps persisted configuration safe even before it
    // is selected for live requests.  The temporary key never leaves memory.
    void new OpenAICompatibleProvider(apiBaseUrl, input.apiKey, input.defaultModel, fetch, apiPath, timeoutMs);
    const encrypted = cipher.encrypt(input.apiKey);
    const id = this.db.get<{ id: string }>("SELECT id FROM ai_provider_configs WHERE provider_key = ?", [input.providerKey])?.id ?? randomUUID();
    const existing = this.db.get<{ encryption_version: number }>("SELECT encryption_version FROM ai_provider_configs WHERE id = ?", [id]);
    const time = iso(this.clock);
    this.db.transaction(() => {
      if (input.enabled === true) this.db.run("UPDATE ai_provider_configs SET enabled = 0, updated_by_id = ?, updated_at = ? WHERE enabled = 1 AND id != ?", [actor.id, time, id]);
      this.db.run("INSERT INTO ai_provider_configs (id, provider_key, display_name, api_base_url, api_path, timeout_ms, default_model, encrypted_api_key, api_key_hint, encryption_version, key_rotated_at, enabled, created_by_id, updated_by_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider_key) DO UPDATE SET display_name = excluded.display_name, api_base_url = excluded.api_base_url, api_path = excluded.api_path, timeout_ms = excluded.timeout_ms, default_model = excluded.default_model, encrypted_api_key = excluded.encrypted_api_key, api_key_hint = excluded.api_key_hint, encryption_version = excluded.encryption_version, key_rotated_at = excluded.key_rotated_at, enabled = excluded.enabled, updated_by_id = excluded.updated_by_id, updated_at = excluded.updated_at", [id, input.providerKey.trim(), input.displayName.trim(), apiBaseUrl, apiPath, timeoutMs, input.defaultModel.trim(), encrypted, maskApiKey(input.apiKey), existing?.encryption_version ? existing.encryption_version + 1 : cipher.version, time, input.enabled === true ? 1 : 0, actor.id, actor.id, time, time]);
    });
    audit(this.db, actor.id, "ai.provider_configured", "ai_provider_config", id, "success", { providerKey: input.providerKey, enabled: input.enabled === true });
    return this.getProvider(actor, id);
  }
  getProvider(actor: Actor, id: string) {
    this.assertAdmin(actor);
    const row = this.db.get<Record<string, any>>("SELECT id, provider_key, display_name, api_base_url, api_path, timeout_ms, default_model, api_key_hint, encryption_version, key_rotated_at, enabled, created_at, updated_at FROM ai_provider_configs WHERE id = ?", [id]);
    if (!row) throw new DomainError("not_found", "AI provider not found", 404);
    return row;
  }
  listProviders(actor: Actor) {
    this.assertAdmin(actor);
    return this.db.all("SELECT id, provider_key, display_name, api_base_url, api_path, timeout_ms, default_model, api_key_hint, encryption_version, key_rotated_at, enabled, created_at, updated_at FROM ai_provider_configs ORDER BY updated_at DESC");
  }
  getSettings(actor: Actor) {
    this.assertAdmin(actor);
    return this.db.get("SELECT id, provider_config_id, enabled, assistant_mode, full_answer_after_attempts, school_daily_token_limit, school_daily_request_limit, student_daily_token_limit, student_daily_request_limit, save_conversations, conversation_retention_days, max_hint_layers, timezone, updated_at FROM ai_settings WHERE id = 'global'") ?? { id: "global", provider_config_id: null, enabled: 0, assistant_mode: "hints_only", full_answer_after_attempts: null, school_daily_token_limit: null, school_daily_request_limit: null, student_daily_token_limit: null, student_daily_request_limit: null, save_conversations: 1, conversation_retention_days: null, max_hint_layers: 3, timezone: "Asia/Macau", updated_at: null };
  }
  disableProvider(actor: Actor, id: string) {
    this.assertAdmin(actor);
    const existing = this.db.get("SELECT id FROM ai_provider_configs WHERE id = ?", [id]);
    if (!existing) throw new DomainError("not_found", "AI provider not found", 404);
    const time = iso(this.clock);
    this.db.transaction(() => {
      this.db.run("UPDATE ai_provider_configs SET enabled = 0, updated_by_id = ?, updated_at = ? WHERE id = ?", [actor.id, time, id]);
      this.db.run("UPDATE ai_settings SET enabled = 0, updated_by_id = ?, updated_at = ? WHERE id = 'global' AND provider_config_id = ?", [actor.id, time, id]);
    });
    audit(this.db, actor.id, "ai.provider_disabled", "ai_provider_config", id, "success");
    return this.getProvider(actor, id);
  }
  activateProvider(actor: Actor, id: string) {
    this.assertAdmin(actor);
    if (!this.db.get("SELECT id FROM ai_provider_configs WHERE id = ?", [id])) throw new DomainError("not_found", "AI provider not found", 404);
    const time = iso(this.clock);
    this.db.transaction(() => {
      this.db.run("UPDATE ai_provider_configs SET enabled = CASE WHEN id = ? THEN 1 ELSE 0 END, updated_by_id = ?, updated_at = ?", [id, actor.id, time]);
      this.db.run("INSERT INTO ai_settings (id, provider_config_id, enabled, max_hint_layers, updated_by_id, created_at, updated_at) VALUES ('global', ?, 0, 3, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET provider_config_id = excluded.provider_config_id, enabled = 0, updated_by_id = excluded.updated_by_id, updated_at = excluded.updated_at", [id, actor.id, time, time]);
    });
    audit(this.db, actor.id, "ai.provider_activated", "ai_provider_config", id, "success");
    return this.getProvider(actor, id);
  }
  resolveProvider(id: string): { provider_key: string; api_base_url: string | null; api_path: string; timeout_ms: number; default_model: string; updated_at: string; encryption_version: number; apiKey: string } {
    if (!this.cipher) throw new DomainError("ai_master_key_missing", "AI master key is not configured", 503);
    const row = this.db.get<Record<string, any>>("SELECT * FROM ai_provider_configs WHERE id = ? AND enabled = 1", [id]);
    if (!row) throw new DomainError("provider_unavailable", "AI provider is not enabled", 503);
    return { provider_key: row.provider_key, api_base_url: row.api_base_url, api_path: row.api_path, timeout_ms: row.timeout_ms, default_model: row.default_model, updated_at: row.updated_at, encryption_version: row.encryption_version, apiKey: this.cipher.decrypt(row.encrypted_api_key) };
  }
  createProvider(id: string): AiProvider {
    const config = this.resolveProvider(id);
    if (config.provider_key === "openai" || config.provider_key.startsWith("openai-compatible")) return new OpenAICompatibleProvider(config.api_base_url ?? "https://api.openai.com/v1", config.apiKey, config.default_model, fetch, config.api_path, config.timeout_ms);
    throw new DomainError("provider_unsupported", "Configured AI provider has no server adapter", 503);
  }
  updateSettings(actor: Actor, input: { enabled?: boolean; providerConfigId?: string | null; assistantMode?: "hints_only" | "progressive" | "full_after_attempts"; fullAnswerAfterAttempts?: number | null; schoolDailyTokenLimit?: number | null; schoolDailyRequestLimit?: number | null; studentDailyTokenLimit?: number | null; studentDailyRequestLimit?: number | null; saveConversations?: boolean; conversationRetentionDays?: number | null; maxHintLayers?: number; timezone?: string }) {
    this.assertAdmin(actor);
    if (input.timezone) usageDate(this.clock, input.timezone);
    for (const value of [input.fullAnswerAfterAttempts, input.schoolDailyTokenLimit, input.schoolDailyRequestLimit, input.studentDailyTokenLimit, input.studentDailyRequestLimit, input.conversationRetentionDays, input.maxHintLayers]) if (value !== undefined && value !== null && (!Number.isInteger(value) || value < 1)) throw new DomainError("invalid_input", "AI limits must be positive");
    if (input.maxHintLayers !== undefined && input.maxHintLayers > 3) throw new DomainError("invalid_input", "Maximum hint layers cannot exceed 3");
    const existing = this.db.get<Record<string, any>>("SELECT * FROM ai_settings WHERE id = 'global'");
    const selectedProviderId = input.providerConfigId === undefined ? existing?.provider_config_id ?? null : input.providerConfigId;
    if (input.enabled && (!selectedProviderId || !this.db.get("SELECT 1 FROM ai_provider_configs WHERE id = ? AND enabled = 1", [selectedProviderId]))) throw new DomainError("provider_unavailable", "Select and activate an AI provider before enabling AI", 503);
    const time = iso(this.clock);
    this.db.run("INSERT INTO ai_settings (id, provider_config_id, enabled, assistant_mode, full_answer_after_attempts, school_daily_token_limit, school_daily_request_limit, student_daily_token_limit, student_daily_request_limit, save_conversations, conversation_retention_days, max_hint_layers, timezone, updated_by_id, created_at, updated_at) VALUES ('global', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET provider_config_id = excluded.provider_config_id, enabled = excluded.enabled, assistant_mode = excluded.assistant_mode, full_answer_after_attempts = excluded.full_answer_after_attempts, school_daily_token_limit = excluded.school_daily_token_limit, school_daily_request_limit = excluded.school_daily_request_limit, student_daily_token_limit = excluded.student_daily_token_limit, student_daily_request_limit = excluded.student_daily_request_limit, save_conversations = excluded.save_conversations, conversation_retention_days = excluded.conversation_retention_days, max_hint_layers = excluded.max_hint_layers, timezone = excluded.timezone, updated_by_id = excluded.updated_by_id, updated_at = excluded.updated_at", [selectedProviderId, input.enabled === undefined ? existing?.enabled ?? 0 : input.enabled ? 1 : 0, input.assistantMode ?? existing?.assistant_mode ?? "hints_only", input.fullAnswerAfterAttempts === undefined ? existing?.full_answer_after_attempts ?? null : input.fullAnswerAfterAttempts, input.schoolDailyTokenLimit === undefined ? existing?.school_daily_token_limit ?? null : input.schoolDailyTokenLimit, input.schoolDailyRequestLimit === undefined ? existing?.school_daily_request_limit ?? null : input.schoolDailyRequestLimit, input.studentDailyTokenLimit === undefined ? existing?.student_daily_token_limit ?? null : input.studentDailyTokenLimit, input.studentDailyRequestLimit === undefined ? existing?.student_daily_request_limit ?? null : input.studentDailyRequestLimit, input.saveConversations === undefined ? existing?.save_conversations ?? 1 : input.saveConversations ? 1 : 0, input.conversationRetentionDays === undefined ? existing?.conversation_retention_days ?? null : input.conversationRetentionDays, input.maxHintLayers ?? existing?.max_hint_layers ?? 3, input.timezone ?? existing?.timezone ?? "Asia/Macau", actor.id, existing?.created_at ?? time, time]);
    audit(this.db, actor.id, "ai.settings_updated", "ai_settings", "global", "success", { enabled: input.enabled, saveConversations: input.saveConversations });
    return this.db.get("SELECT id, provider_config_id, enabled, assistant_mode, full_answer_after_attempts, school_daily_token_limit, school_daily_request_limit, student_daily_token_limit, student_daily_request_limit, save_conversations, conversation_retention_days, max_hint_layers, timezone, updated_by_id, created_at, updated_at FROM ai_settings WHERE id = 'global'");
  }
}

export class ConfiguredAiProvider implements AiProvider {
  private cached: { signature: string; provider: AiProvider } | null = null;
  private readonly db: LocalDatabase;
  private readonly admin: AiAdminService;
  constructor(db: LocalDatabase, admin: AiAdminService) { this.db = db; this.admin = admin; }
  async generate(request: ProviderRequest) {
    const selected = this.db.get<Record<string, any>>("SELECT p.id, p.updated_at, p.encryption_version FROM ai_settings s JOIN ai_provider_configs p ON p.id = s.provider_config_id WHERE s.id = 'global' AND s.enabled = 1 AND p.enabled = 1");
    if (!selected) throw new DomainError("provider_unavailable", "AI provider is not configured", 503);
    const signature = `${selected.id}:${selected.updated_at}:${selected.encryption_version}`;
    if (!this.cached || this.cached.signature !== signature) this.cached = { signature, provider: this.admin.createProvider(selected.id) };
    return this.cached.provider.generate(request);
  }
}

type SettingsRow = {
  provider_config_id: string | null;
  enabled: number;
  assistant_mode: string;
  full_answer_after_attempts: number | null;
  school_daily_token_limit: number | null;
  school_daily_request_limit: number | null;
  student_daily_token_limit: number | null;
  student_daily_request_limit: number | null;
  save_conversations: number;
  conversation_retention_days: number | null;
  timezone: string;
};

class QuotaService {
  private readonly db: LocalDatabase;
  private readonly clock: Clock;
  constructor(db: LocalDatabase, clock: Clock) { this.db = db; this.clock = clock; }
  private changes() { return this.db.get<{ changes: number }>("SELECT changes() AS changes")?.changes ?? 0; }
  settings() {
    return this.db.get<SettingsRow>("SELECT provider_config_id, enabled, assistant_mode, full_answer_after_attempts, school_daily_token_limit, school_daily_request_limit, student_daily_token_limit, student_daily_request_limit, save_conversations, conversation_retention_days, timezone FROM ai_settings WHERE id = 'global'") ?? { provider_config_id: null, enabled: 0, assistant_mode: "hints_only", full_answer_after_attempts: null, school_daily_token_limit: null, school_daily_request_limit: null, student_daily_token_limit: null, student_daily_request_limit: null, save_conversations: 1, conversation_retention_days: null, timezone: "Asia/Macau" };
  }
  reserve(userId: string, reservationKey: string, estimatedTokens: number, providerConfigId: string | null) {
    const settings = this.settings();
    const date = usageDate(this.clock, settings.timezone);
    const id = randomUUID();
    let result: Record<string, any> | undefined;
    this.db.transaction(() => {
      const existing = this.db.get<Record<string, any>>("SELECT * FROM ai_reservations WHERE reservation_key = ?", [reservationKey]);
      if (existing) { result = existing; return; }
      const time = iso(this.clock);
      this.db.run("INSERT INTO ai_daily_quotas (user_id, usage_date, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id, usage_date) DO NOTHING", [userId, date, time]);
      this.db.run("INSERT INTO ai_school_daily_quotas (usage_date, updated_at) VALUES (?, ?) ON CONFLICT(usage_date) DO NOTHING", [date, time]);
      this.db.run("UPDATE ai_daily_quotas SET reserved_requests = reserved_requests + 1, reserved_tokens = reserved_tokens + ?, updated_at = ? WHERE user_id = ? AND usage_date = ? AND (? IS NULL OR completed_requests + reserved_requests + 1 <= ?) AND (? IS NULL OR used_tokens + reserved_tokens + ? <= ?)", [estimatedTokens, time, userId, date, settings.student_daily_request_limit, settings.student_daily_request_limit, settings.student_daily_token_limit, estimatedTokens, settings.student_daily_token_limit]);
      if (this.changes() !== 1) throw new DomainError("ai_quota_exceeded", "Student AI quota exceeded", 429);
      this.db.run("UPDATE ai_school_daily_quotas SET reserved_requests = reserved_requests + 1, reserved_tokens = reserved_tokens + ?, updated_at = ? WHERE usage_date = ? AND (? IS NULL OR completed_requests + reserved_requests + 1 <= ?) AND (? IS NULL OR used_tokens + reserved_tokens + ? <= ?)", [estimatedTokens, time, date, settings.school_daily_request_limit, settings.school_daily_request_limit, settings.school_daily_token_limit, estimatedTokens, settings.school_daily_token_limit]);
      if (this.changes() !== 1) throw new DomainError("ai_quota_exceeded", "School AI quota exceeded", 429);
      this.db.run("INSERT INTO ai_reservations (id, reservation_key, user_id, provider_config_id, usage_date, reserved_requests, reserved_tokens, status, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, 'reserved', ?)", [id, reservationKey, userId, providerConfigId, date, estimatedTokens, time]);
      result = this.db.get("SELECT * FROM ai_reservations WHERE id = ?", [id]);
    });
    return result;
  }
  settle(reservationId: string, inputTokens: number, outputTokens: number, model: string, purpose: string, providerConfigId: string | null, conversationId: string | null, latencyMs: number, status: "success" | "error", errorCode: string | null) {
    const existing = this.db.get<Record<string, any>>("SELECT * FROM ai_reservations WHERE id = ?", [reservationId]);
    if (!existing) throw new DomainError("not_found", "AI reservation not found", 404);
    if (existing.status !== "reserved") return existing;
    if (inputTokens + outputTokens > existing.reserved_tokens) throw new DomainError("ai_usage_exceeds_reservation", "AI provider usage exceeded its reservation", 502);
    const chargedTokens = Math.max(0, inputTokens + outputTokens);
    const time = iso(this.clock);
    this.db.transaction(() => {
      this.db.run("UPDATE ai_daily_quotas SET reserved_requests = reserved_requests - 1, completed_requests = completed_requests + ?, reserved_tokens = reserved_tokens - ?, used_tokens = used_tokens + ?, updated_at = ? WHERE user_id = ? AND usage_date = ?", [status === "success" ? 1 : 0, existing.reserved_tokens, chargedTokens, time, existing.user_id, existing.usage_date]);
      this.db.run("UPDATE ai_school_daily_quotas SET reserved_requests = reserved_requests - 1, completed_requests = completed_requests + ?, reserved_tokens = reserved_tokens - ?, used_tokens = used_tokens + ?, updated_at = ? WHERE usage_date = ?", [status === "success" ? 1 : 0, existing.reserved_tokens, chargedTokens, time, existing.usage_date]);
      this.db.run("UPDATE ai_reservations SET status = ?, input_tokens = ?, output_tokens = ?, settled_at = ? WHERE id = ?", [status === "success" ? "settled" : "rolled_back", inputTokens, outputTokens, time, reservationId]);
      this.db.run("INSERT INTO ai_usage (id, user_id, provider_config_id, conversation_id, purpose, usage_date, model, input_tokens, output_tokens, latency_ms, status, error_code, reservation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [randomUUID(), existing.user_id, providerConfigId, conversationId, purpose, existing.usage_date, model, inputTokens, outputTokens, latencyMs, status, errorCode, reservationId, time]);
    });
    return this.db.get("SELECT * FROM ai_reservations WHERE id = ?", [reservationId]);
  }
}

function promptFor(input: { task: string; questionPrompt?: string; studentCode?: string; runnerFeedback?: string; hintLevel?: number }, policy: { assistantMode: string; allowFullAnswer: boolean }) {
  if (!input.task.trim()) throw new DomainError("invalid_input", "AI task is required");
  const hintLevel = Math.max(1, Math.min(3, Number(input.hintLevel ?? 1)));
  const payload = { task: input.task.trim(), questionPrompt: input.questionPrompt?.trim() ?? "", studentCode: input.studentCode ?? "", runnerFeedback: input.runnerFeedback ?? "", hintLevel };
  const levelInstruction = hintLevel === 1 ? "Give a conceptual direction only." : hintLevel === 2 ? "Add one relevant syntax or debugging clue, building on the previous hint." : "Give concrete pseudocode or a partial example, but still withhold the final answer unless policy allows it.";
  const instruction = policy.allowFullAnswer
    ? "Give progressive educational guidance. A complete worked answer is allowed because the server attempt policy threshold has been reached."
    : policy.assistantMode === "progressive"
      ? `Give one progressive educational hint and a next-step question. ${levelInstruction} Do not provide a complete answer.`
      : `Give one concise educational hint. ${levelInstruction} Do not provide a complete answer or final code.`;
  return [{ role: "system" as const, content: instruction }, { role: "user" as const, content: JSON.stringify(payload) }];
}

export class AiService {
  private readonly clock: Clock;
  private readonly quota: QuotaService;
  private readonly db: LocalDatabase;
  private readonly provider: AiProvider;
  constructor(db: LocalDatabase, provider: AiProvider, clock: Clock = () => new Date()) { this.db = db; this.provider = provider; this.clock = clock; this.quota = new QuotaService(db, clock); }
  private conversation(id: string) { return this.db.get<Record<string, any>>("SELECT * FROM ai_conversations WHERE id = ?", [id]); }
  private assertActive(actor: Actor) {
    const user = this.db.get<{ role: string; status: string }>("SELECT role, status FROM users WHERE id = ?", [actor.id]);
    if (!user || user.role !== actor.role || user.status !== "active") throw new DomainError("unauthorized", "Active session required", 401);
  }
  private assertConversationScope(actor: Actor, conversation: Record<string, any>) {
    if (conversation.student_id !== actor.id) throw new DomainError("not_found", "Conversation not found", 404);
    const course = this.db.get<{ status: string; enrollment_status: string }>("SELECT c.status, ce.status AS enrollment_status FROM courses c JOIN course_enrollments ce ON ce.course_id = c.id AND ce.student_id = ? WHERE c.id = ?", [actor.id, conversation.course_id]);
    if (!course || course.status !== "published" || course.enrollment_status !== "active") throw new DomainError("not_found", "Conversation not found", 404);
    if (conversation.assignment_id) {
      const assignment = this.db.get("SELECT a.id FROM assignments a LEFT JOIN units u ON u.id = a.unit_id AND u.course_id = a.course_id WHERE a.id = ? AND a.course_id = ? AND a.status IN ('published', 'closed') AND (a.publish_at IS NULL OR datetime(a.publish_at) <= datetime(?)) AND (a.unit_id IS NULL OR u.status = 'published')", [conversation.assignment_id, conversation.course_id, this.clock().toISOString()]);
      if (!assignment) throw new DomainError("not_found", "Conversation not found", 404);
    }
    if (conversation.question_id) {
      const question = this.db.get("SELECT q.id FROM questions q LEFT JOIN units u ON u.id = q.unit_id AND u.course_id = q.course_id WHERE q.id = ? AND q.course_id = ? AND q.status = 'published' AND (q.unit_id IS NULL OR u.status = 'published')", [conversation.question_id, conversation.course_id]);
      if (!question) throw new DomainError("not_found", "Conversation not found", 404);
    }
    return conversation;
  }
  startConversation(actor: Actor, courseId: string, assignmentId?: string, questionId?: string) {
    this.assertActive(actor);
    if (actor.role !== "student") throw new DomainError("forbidden", "Student permission required", 403);
    if (!canViewCourse(this.db, actor, courseId)) throw new DomainError("not_found", "Course not found", 404);
    if (assignmentId && !this.db.get("SELECT 1 FROM assignments WHERE id = ? AND course_id = ? AND status IN ('published', 'closed')", [assignmentId, courseId])) throw new DomainError("not_found", "Assignment not found", 404);
    if (questionId && !this.db.get("SELECT 1 FROM questions WHERE id = ? AND course_id = ? AND status = 'published'", [questionId, courseId])) throw new DomainError("not_found", "Question not found", 404);
    const existing = this.db.get<Record<string, any>>("SELECT ac.*, (SELECT COUNT(*) FROM ai_usage au WHERE au.conversation_id = ac.id AND au.user_id = ? AND au.purpose = 'student_hint' AND au.status = 'success') AS successful_hint_count FROM ai_conversations ac WHERE ac.student_id = ? AND ac.course_id = ? AND ac.assignment_id IS ? AND ac.question_id IS ? ORDER BY ac.last_message_at DESC LIMIT 1", [actor.id, actor.id, courseId, assignmentId ?? null, questionId ?? null]);
    if (existing) return existing;
    const id = randomUUID();
    const time = iso(this.clock);
    this.db.run("INSERT INTO ai_conversations (id, student_id, course_id, assignment_id, question_id, started_at, last_message_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [id, actor.id, courseId, assignmentId ?? null, questionId ?? null, time, time]);
    return this.db.get("SELECT ac.*, 0 AS successful_hint_count FROM ai_conversations ac WHERE id = ?", [id]);
  }
  async request(actor: Actor, input: { requestKey: string; purpose: string; task: string; model?: string; questionPrompt?: string; studentCode?: string; runnerFeedback?: string; conversationId?: string; estimatedTokens?: number; hintLevel?: number }) {
    this.assertActive(actor);
    if (!input.requestKey?.trim()) throw new DomainError("invalid_input", "AI request key is required");
    if (!PURPOSES.has(input.purpose)) throw new DomainError("invalid_input", "AI purpose is invalid");
    if (input.conversationId) {
      const scopedConversation = this.conversation(input.conversationId);
      if (!scopedConversation) throw new DomainError("not_found", "Conversation not found", 404);
      this.assertConversationScope(actor, scopedConversation);
    } else if (actor.role === "student" && !this.db.get("SELECT 1 FROM course_enrollments ce JOIN courses c ON c.id = ce.course_id WHERE ce.student_id = ? AND ce.status = 'active' AND c.status = 'published'", [actor.id])) {
      throw new DomainError("not_found", "No active student course is available", 404);
    }
    const settings = this.quota.settings();
    if (!settings.enabled || !settings.provider_config_id) throw new DomainError("ai_disabled", "AI assistant is disabled", 503);
    const providerConfig = this.db.get<{ default_model: string }>("SELECT default_model FROM ai_provider_configs WHERE id = ? AND enabled = 1", [settings.provider_config_id]);
    if (!providerConfig) throw new DomainError("provider_unavailable", "Configured AI provider is unavailable", 503);
    // The selected model is server policy.  A browser-supplied model must not
    // override the administrator's provider configuration.
    const model = providerConfig.default_model;
    let observedAttempts = 0;
    let hintLevel = Math.max(1, Math.min(3, Number(input.hintLevel ?? 1)));
    if (input.conversationId) {
      const conversation = this.conversation(input.conversationId);
      if (!conversation) throw new DomainError("not_found", "Conversation not found", 404);
      this.assertConversationScope(actor, conversation);
      if (conversation.assignment_id) observedAttempts = this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM submissions WHERE assignment_id = ? AND student_id = ? AND status != 'draft'", [conversation.assignment_id, actor.id])?.count ?? 0;
      if (input.purpose === "student_hint") hintLevel = Math.min(3, (this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM ai_usage WHERE conversation_id = ? AND user_id = ? AND purpose = 'student_hint' AND status = 'success'", [input.conversationId, actor.id])?.count ?? 0) + 1);
    }
    const allowFullAnswer = settings.assistant_mode === "full_after_attempts" && Boolean(settings.full_answer_after_attempts) && observedAttempts >= Number(settings.full_answer_after_attempts);
    const messages = promptFor({ task: input.task, questionPrompt: input.questionPrompt, studentCode: input.studentCode, runnerFeedback: input.runnerFeedback, hintLevel }, { assistantMode: settings.assistant_mode, allowFullAnswer });
    const estimated = Math.max(1, Math.min(100000, Math.floor(input.estimatedTokens ?? Math.ceil(JSON.stringify(messages).length / 4) + 256)));
    let reservation: Record<string, any>;
    try {
      reservation = this.quota.reserve(actor.id, input.requestKey, estimated, settings.provider_config_id) as Record<string, any>;
    } catch (error) {
      const domain = error instanceof DomainError ? error : new DomainError("ai_quota_failed", "AI quota reservation failed", 500);
      audit(this.db, actor.id, "ai.request_rejected", "ai_request", input.requestKey, "denied", { purpose: input.purpose, code: domain.code });
      throw domain;
    }
    if (reservation.status !== "reserved") return { requestKey: input.requestKey, reservationId: reservation.id, status: reservation.status, content: null, replay: true };
    const started = Date.now();
    try {
      const response = await this.provider.generate({ model, messages });
      const settled = this.quota.settle(reservation.id, response.inputTokens, response.outputTokens, response.model ?? model, input.purpose, settings.provider_config_id, input.conversationId ?? null, Date.now() - started, "success", null);
      if (settings.save_conversations && input.conversationId) this.saveMessages(input.conversationId, actor.id, messages[1].content, response.content);
      audit(this.db, actor.id, "ai.request_completed", "ai_request", input.requestKey, "success", { purpose: input.purpose, reservationId: reservation.id, inputTokens: response.inputTokens, outputTokens: response.outputTokens });
      return { requestKey: input.requestKey, reservationId: (settled as Record<string, any>).id, status: "success", content: response.content, hintLevel, usage: { inputTokens: response.inputTokens, outputTokens: response.outputTokens } };
    } catch (error) {
      const domain = error instanceof DomainError ? error : new DomainError("provider_failed", "AI provider failed", 502);
      this.quota.settle(reservation.id, 0, 0, model, input.purpose, settings.provider_config_id, input.conversationId ?? null, Date.now() - started, "error", domain.code);
      audit(this.db, actor.id, "ai.request_failed", "ai_request", input.requestKey, "failure", { purpose: input.purpose, reservationId: reservation.id, code: domain.code });
      throw domain;
    }
  }
  async requestArtifact(actor: Actor, input: { requestKey: string; purpose: "summary" | "translation" | "grading" | "feedback"; artifactType: "material" | "translation" | "feedback" | "suggested_score"; payload: Record<string, unknown>; instruction: string }) {
    this.assertActive(actor);
    requireStaff(actor);
    if (!input.requestKey?.trim() || input.requestKey.trim().length > 128) throw new DomainError("invalid_input", "AI artifact request key is required");
    const settings = this.quota.settings();
    if (!settings.enabled || !settings.provider_config_id) throw new DomainError("ai_disabled", "AI assistant is disabled", 503);
    const providerConfig = this.db.get<{ default_model: string }>("SELECT default_model FROM ai_provider_configs WHERE id = ? AND enabled = 1", [settings.provider_config_id]);
    if (!providerConfig) throw new DomainError("provider_unavailable", "Configured AI provider is unavailable", 503);
    if (!input.instruction.trim()) throw new DomainError("invalid_input", "AI artifact instruction is required");
    const messages: ProviderMessage[] = [
      { role: "system", content: `${input.instruction.trim()} Return JSON only, with no markdown and no extra keys. Do not include personal identifiers.` },
      { role: "user", content: JSON.stringify(input.payload) },
    ];
    const estimated = Math.max(1, Math.min(100000, Math.ceil(JSON.stringify(messages).length / 4) + 512));
    const reservationKey = `artifact:${input.artifactType}:${input.requestKey.trim()}`;
    let reservation: Record<string, any>;
    try {
      reservation = this.quota.reserve(actor.id, reservationKey, estimated, settings.provider_config_id) as Record<string, any>;
    } catch (error) {
      const domain = error instanceof DomainError ? error : new DomainError("ai_quota_failed", "AI quota reservation failed", 500);
      audit(this.db, actor.id, "ai.artifact_generation_rejected", "ai_request", input.requestKey, "denied", { artifactType: input.artifactType, code: domain.code });
      throw domain;
    }
    if (reservation.status !== "reserved") return { requestKey: input.requestKey.trim(), reservationId: reservation.id, status: reservation.status, content: null, replay: true };
    const started = Date.now();
    try {
      const response = await this.provider.generate({ model: providerConfig.default_model, messages, temperature: 0.2 });
      const settled = this.quota.settle(reservation.id, response.inputTokens, response.outputTokens, response.model ?? providerConfig.default_model, input.purpose, settings.provider_config_id, null, Date.now() - started, "success", null);
      audit(this.db, actor.id, "ai.artifact_generation_completed", "ai_request", input.requestKey, "success", { artifactType: input.artifactType, reservationId: reservation.id, inputTokens: response.inputTokens, outputTokens: response.outputTokens });
      return { requestKey: input.requestKey.trim(), reservationId: (settled as Record<string, any>).id, status: "success", content: response.content, usage: { inputTokens: response.inputTokens, outputTokens: response.outputTokens } };
    } catch (error) {
      const domain = error instanceof DomainError ? error : new DomainError("provider_failed", "AI provider failed", 502);
      this.quota.settle(reservation.id, 0, 0, providerConfig.default_model, input.purpose, settings.provider_config_id, null, Date.now() - started, "error", domain.code);
      audit(this.db, actor.id, "ai.artifact_generation_failed", "ai_request", input.requestKey, "failure", { artifactType: input.artifactType, reservationId: reservation.id, code: domain.code });
      throw domain;
    }
  }
  async requestAuthoring(actor: Actor, input: { requestKey: string; courseId: string; type: string; topic: string; concepts: string[]; instructions?: string; maxScore?: number }) {
    this.assertActive(actor);
    requireStaff(actor);
    if (!canManageCourse(this.db, actor, input.courseId)) throw new DomainError("not_found", "Course not found", 404);
    if (!input.requestKey?.trim()) throw new DomainError("invalid_input", "AI request key is required");
    if (!AUTHORING_TYPES.has(input.type)) throw new DomainError("invalid_input", "Question type is invalid");
    const settings = this.quota.settings();
    if (!settings.enabled || !settings.provider_config_id) throw new DomainError("ai_disabled", "AI assistant is disabled", 503);
    const providerConfig = this.db.get<{ default_model: string }>("SELECT default_model FROM ai_provider_configs WHERE id = ? AND enabled = 1", [settings.provider_config_id]);
    if (!providerConfig) throw new DomainError("provider_unavailable", "Configured AI provider is unavailable", 503);
    const model = providerConfig.default_model;
    const payload = { type: input.type, topic: input.topic.trim(), concepts: input.concepts, instructions: input.instructions?.trim() ?? "", maxScore: input.maxScore ?? 1 };
    const messages: ProviderMessage[] = [
      { role: "system", content: "You author one educational question for a Python learning platform. Return JSON only, with no markdown and no extra keys. Required fields: type,titleZh,promptZh,requiredConcepts,maxScore. Optional fields: titleEn,promptEn,optionsJson,answerKeyJson,explanationZh,explanationEn,starterCode,solutionCode,testCases. Test cases must contain visibility, inputJson, expectedOutput, comparisonMode, tolerance, weight, position, timeLimitMs, memoryLimitMb." },
      { role: "user", content: JSON.stringify(payload) },
    ];
    const estimated = Math.max(1, Math.min(100000, Math.ceil(JSON.stringify(messages).length / 4) + 512));
    const reservationKey = `question-authoring:${input.courseId}:${input.requestKey.trim()}`;
    let reservation: Record<string, any>;
    try {
      reservation = this.quota.reserve(actor.id, reservationKey, estimated, settings.provider_config_id) as Record<string, any>;
    } catch (error) {
      const domain = error instanceof DomainError ? error : new DomainError("ai_quota_failed", "AI quota reservation failed", 500);
      audit(this.db, actor.id, "ai.question_authoring_rejected", "ai_request", input.requestKey, "denied", { code: domain.code });
      throw domain;
    }
    if (reservation.status !== "reserved") return { requestKey: input.requestKey, reservationId: reservation.id, status: reservation.status, content: null, replay: true };
    const started = Date.now();
    try {
      const response = await this.provider.generate({ model, messages, temperature: 0.2 });
      const settled = this.quota.settle(reservation.id, response.inputTokens, response.outputTokens, response.model ?? model, "question_generation", settings.provider_config_id, null, Date.now() - started, "success", null);
      audit(this.db, actor.id, "ai.question_authoring_completed", "ai_request", input.requestKey, "success", { reservationId: reservation.id, inputTokens: response.inputTokens, outputTokens: response.outputTokens });
      return { requestKey: input.requestKey, reservationId: (settled as Record<string, any>).id, status: "success", content: response.content, usage: { inputTokens: response.inputTokens, outputTokens: response.outputTokens } };
    } catch (error) {
      const domain = error instanceof DomainError ? error : new DomainError("provider_failed", "AI provider failed", 502);
      this.quota.settle(reservation.id, 0, 0, model, "question_generation", settings.provider_config_id, null, Date.now() - started, "error", domain.code);
      audit(this.db, actor.id, "ai.question_authoring_failed", "ai_request", input.requestKey, "failure", { reservationId: reservation.id, code: domain.code });
      throw domain;
    }
  }
  status(actor: Actor) {
    this.assertActive(actor);
    if (actor.role === "student" && !this.db.get("SELECT 1 FROM course_enrollments ce JOIN courses c ON c.id = ce.course_id WHERE ce.student_id = ? AND ce.status = 'active' AND c.status = 'published'", [actor.id])) throw new DomainError("not_found", "No active student course is available", 404);
    const settings = this.quota.settings();
    const date = usageDate(this.clock, settings.timezone);
    const own = this.db.get<Record<string, any>>("SELECT completed_requests, used_tokens, reserved_requests, reserved_tokens FROM ai_daily_quotas WHERE user_id = ? AND usage_date = ?", [actor.id, date]) ?? { completed_requests: 0, used_tokens: 0, reserved_requests: 0, reserved_tokens: 0 };
    const remaining = (limit: number | null, used: number) => limit === null ? null : Math.max(0, limit - used);
    const enabled = Boolean(settings.enabled && settings.provider_config_id && this.db.get("SELECT 1 FROM ai_provider_configs WHERE id = ? AND enabled = 1", [settings.provider_config_id]));
    if (actor.role === "student") return { enabled, hintLevel: 0, maxHintLevel: this.db.get<{ value: number }>("SELECT max_hint_layers AS value FROM ai_settings WHERE id = 'global'")?.value ?? 3 };
    return {
      enabled,
      assistantMode: settings.assistant_mode,
      fullAnswerAfterAttempts: settings.full_answer_after_attempts,
      saveConversations: Boolean(settings.save_conversations),
      usageDate: date,
      remainingRequests: remaining(settings.student_daily_request_limit, Number(own.completed_requests) + Number(own.reserved_requests)),
      remainingTokens: remaining(settings.student_daily_token_limit, Number(own.used_tokens) + Number(own.reserved_tokens)),
    };
  }
  private saveMessages(conversationId: string, studentId: string, prompt: string, response: string) {
    const current = this.db.get<{ max: number | null }>("SELECT MAX(sequence_number) AS max FROM ai_messages WHERE conversation_id = ?", [conversationId])?.max ?? 0;
    const time = iso(this.clock);
    this.db.transaction(() => {
      this.db.run("INSERT INTO ai_messages (id, conversation_id, role, content, sequence_number, prompt_version, created_at) VALUES (?, ?, 'student', ?, ?, 'p4-minimal-v1', ?)", [randomUUID(), conversationId, prompt, current + 1, time]);
      this.db.run("INSERT INTO ai_messages (id, conversation_id, role, content, sequence_number, prompt_version, created_at) VALUES (?, ?, 'assistant', ?, ?, 'p4-minimal-v1', ?)", [randomUUID(), conversationId, response, current + 2, time]);
      this.db.run("UPDATE ai_conversations SET last_message_at = ? WHERE id = ?", [time, conversationId]);
    });
  }
  listConversation(actor: Actor, conversationId: string) {
    const conversation = this.conversation(conversationId);
    if (!conversation || !canViewCourse(this.db, actor, conversation.course_id) || (actor.role === "student" && conversation.student_id !== actor.id)) throw new DomainError("not_found", "Conversation not found", 404);
    return { conversation, messages: this.db.all("SELECT id, role, content, sequence_number, prompt_version, input_tokens, output_tokens, created_at FROM ai_messages WHERE conversation_id = ? ORDER BY sequence_number", [conversationId]) };
  }
  cleanupExpired(actor: Actor) {
    requireStaff(actor);
    const settings = this.quota.settings();
    if (!settings.conversation_retention_days) return { deletedConversations: 0, deletedMessages: 0 };
    const cutoff = new Date(this.clock().getTime() - settings.conversation_retention_days * 86400000).toISOString();
    const ids = this.db.all<{ id: string }>("SELECT id FROM ai_conversations WHERE last_message_at < ?", [cutoff]);
    let messages = 0;
    this.db.transaction(() => {
      for (const row of ids) {
        messages += this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM ai_messages WHERE conversation_id = ?", [row.id])?.count ?? 0;
        this.db.run("DELETE FROM ai_messages WHERE conversation_id = ?", [row.id]);
        this.db.run("DELETE FROM ai_conversations WHERE id = ?", [row.id]);
      }
    });
    audit(this.db, actor.id, "ai.conversations_cleaned", "ai_conversations", null, "success", { deletedConversations: ids.length, deletedMessages: messages });
    return { deletedConversations: ids.length, deletedMessages: messages };
  }
}

export class AiReviewService {
  private readonly clock: Clock;
  private readonly db: LocalDatabase;
  constructor(db: LocalDatabase, clock: Clock = () => new Date()) { this.db = db; this.clock = clock; }
  private normalizeQuestionContent(raw: Record<string, any>, input: { type: string; concepts: string[]; maxScore?: number; unitId?: string }) {
    const type = typeof raw.type === "string" ? raw.type : input.type;
    if (type !== input.type || !AUTHORING_TYPES.has(type)) throw new DomainError("ai_question_invalid", "AI question type is invalid", 502);
    const titleZh = boundedText(raw.titleZh, "titleZh", 500, true);
    const promptZh = boundedText(raw.promptZh, "promptZh", 10000, true);
    const titleEn = boundedText(raw.titleEn, "titleEn", 500);
    const promptEn = boundedText(raw.promptEn, "promptEn", 10000);
    const optionsJson = raw.optionsJson ?? null;
    if (type === "multiple_choice" && (!Array.isArray(optionsJson) || optionsJson.length < 2 || optionsJson.length > 100)) throw new DomainError("ai_question_invalid", "AI multiple choice options are invalid", 502);
    if ((type === "code_fill" || type === "python_code") && typeof raw.starterCode !== "string") throw new DomainError("ai_question_invalid", "AI code question starterCode is required", 502);
    const maxScore = raw.maxScore === undefined ? input.maxScore ?? 1 : Number(raw.maxScore);
    if (!Number.isFinite(maxScore) || maxScore < 0 || maxScore > 10000) throw new DomainError("ai_question_invalid", "AI question maxScore is invalid", 502);
    let requiredConcepts: string[];
    try { requiredConcepts = normalizeQuestionConcepts(raw.requiredConcepts ?? input.concepts); }
    catch { throw new DomainError("ai_question_invalid", "AI question concepts are invalid", 502); }
    const testCases = raw.testCases === undefined ? [] : raw.testCases;
    if (!Array.isArray(testCases) || testCases.length > 100) throw new DomainError("ai_question_invalid", "AI question testCases are invalid", 502);
    if (!AUTHORING_TYPES.has(type) || !["code_fill", "python_code"].includes(type) && testCases.length > 0) throw new DomainError("ai_question_invalid", "Only code questions may contain test cases", 502);
    const normalizedTests = testCases.map((test: Record<string, any>, index: number) => {
      if (!test || !["public", "hidden"].includes(test.visibility) || typeof test.expectedOutput !== "string" || !test.expectedOutput.trim()) throw new DomainError("ai_question_invalid", `AI test case ${index + 1} is invalid`, 502);
      const comparisonMode = test.comparisonMode ?? "trimmed";
      if (!["exact", "trimmed", "numeric_tolerance"].includes(comparisonMode)) throw new DomainError("ai_question_invalid", `AI test case ${index + 1} comparison mode is invalid`, 502);
      const numeric = (value: unknown, fallback: number | null, label: string) => {
        if (value === undefined || value === null) return fallback;
        const result = Number(value);
        if (!Number.isFinite(result) || result < 0) throw new DomainError("ai_question_invalid", `AI test case ${index + 1} ${label} is invalid`, 502);
        return result;
      };
      const integer = (value: unknown, fallback: number | null, label: string) => {
        const result = numeric(value, fallback, label);
        if (result !== null && !Number.isInteger(result)) throw new DomainError("ai_question_invalid", `AI test case ${index + 1} ${label} must be an integer`, 502);
        return result;
      };
      return {
        visibility: test.visibility, label: boundedText(test.label, "test label", 200), inputJson: test.inputJson ?? null,
        expectedOutput: test.expectedOutput.trim(), comparisonMode, tolerance: numeric(test.tolerance, null, "tolerance"),
        weight: numeric(test.weight, 1, "weight"), position: integer(test.position, index, "position"),
        timeLimitMs: integer(test.timeLimitMs, null, "timeLimitMs"), memoryLimitMb: integer(test.memoryLimitMb, null, "memoryLimitMb"),
      };
    });
    return {
      requestKey: "", type, titleZh, titleEn, promptZh, promptEn, optionsJson,
      answerKeyJson: raw.answerKeyJson ?? null, explanationZh: boundedText(raw.explanationZh, "explanationZh", 10000), explanationEn: boundedText(raw.explanationEn, "explanationEn", 10000),
      starterCode: boundedText(raw.starterCode, "starterCode", 20000), solutionCode: boundedText(raw.solutionCode, "solutionCode", 20000),
      requiredConcepts, maxScore, unitId: input.unitId ?? null, testCases: normalizedTests,
    };
  }
  async generateQuestion(actor: Actor, courseId: string, input: { requestKey: string; type: string; topic: string; concepts?: unknown; instructions?: string; maxScore?: number; unitId?: string }, ai: AiService) {
    requireStaff(actor);
    if (!canManageCourse(this.db, actor, courseId)) throw new DomainError("not_found", "Course not found", 404);
    const requestKey = input.requestKey?.trim();
    const topic = input.topic?.trim();
    if (!requestKey || requestKey.length > 128 || !topic || topic.length > 200) throw new DomainError("invalid_input", "Question authoring requestKey and topic are required");
    if (!AUTHORING_TYPES.has(input.type)) throw new DomainError("invalid_input", "Question type is invalid");
    const concepts = normalizeQuestionConcepts(input.concepts);
    const instructions = input.instructions?.trim() ?? "";
    if (instructions.length > 4000) throw new DomainError("invalid_input", "Question authoring instructions are too long");
    if (input.maxScore !== undefined && (!Number.isFinite(input.maxScore) || input.maxScore < 0 || input.maxScore > 10000)) throw new DomainError("invalid_input", "Question maxScore is invalid");
    if (input.unitId) {
      const unit = this.db.get<{ course_id: string; status: string }>("SELECT course_id, status FROM units WHERE id = ?", [input.unitId]);
      if (!unit || unit.course_id !== courseId || unit.status === "archived") throw new DomainError("invalid_reference", "Question unit and course must match");
    }
    const existing = this.db.all<Record<string, any>>("SELECT id, content_json FROM ai_artifacts WHERE artifact_type = 'question' AND course_id = ? ORDER BY created_at DESC", [courseId]).find((row) => {
      try { return parseJson(row.content_json, "contentJson")?.requestKey === requestKey; } catch { return false; }
    });
    if (existing) return this.getStaff(actor, existing.id);
    const result = await ai.requestAuthoring(actor, { requestKey, courseId, type: input.type, topic, concepts, instructions, maxScore: input.maxScore });
    if (!result.content) throw new DomainError("ai_request_replay", "AI request was already completed; retrieve the existing artifact", 409);
    const content = this.normalizeQuestionContent(parseAuthoringJson(result.content), { type: input.type, concepts, maxScore: input.maxScore, unitId: input.unitId });
    content.requestKey = requestKey;
    return this.create(actor, { artifactType: "question", courseId, content });
  }
  private normalizeGeneratedArtifact(raw: Record<string, any>, input: { artifactType: "material" | "translation" | "feedback" | "suggested_score"; requestKey: string; targetLocale?: string; maxScore?: number }) {
    if (input.artifactType === "material") {
      const summaryZh = artifactText(raw.summaryZh, "summaryZh", 12000, true);
      const summaryEn = artifactText(raw.summaryEn, "summaryEn", 12000);
      const keyPoints = artifactList(raw.keyPoints, "keyPoints", 12, 500);
      if (!keyPoints.length) throw new DomainError("ai_artifact_invalid", "AI artifact keyPoints are required", 502);
      return { requestKey: input.requestKey, summaryZh, summaryEn, keyPoints };
    }
    if (input.artifactType === "translation") {
      const targetLocale = input.targetLocale ?? artifactText(raw.targetLocale, "targetLocale", 32, true);
      if (!targetLocale || !/^[A-Za-z0-9][A-Za-z0-9-]{1,31}$/.test(targetLocale)) throw new DomainError("ai_artifact_invalid", "AI artifact targetLocale is invalid", 502);
      return { requestKey: input.requestKey, sourceLocale: artifactText(raw.sourceLocale, "sourceLocale", 32), targetLocale, translatedText: artifactText(raw.translatedText, "translatedText", 30000, true) };
    }
    if (input.artifactType === "feedback") {
      return {
        requestKey: input.requestKey,
        feedbackZh: artifactText(raw.feedbackZh, "feedbackZh", 10000, true),
        feedbackEn: artifactText(raw.feedbackEn, "feedbackEn", 10000),
        strengths: artifactList(raw.strengths, "strengths", 10, 500),
        improvements: artifactList(raw.improvements, "improvements", 10, 500),
        nextStep: artifactText(raw.nextStep, "nextStep", 2000),
      };
    }
    const score = typeof raw.score === "number" ? raw.score : Number.NaN;
    if (!Number.isFinite(score) || score < 0 || score > Number(input.maxScore ?? 0)) throw new DomainError("ai_artifact_invalid", "AI suggested score is invalid", 502);
    return { requestKey: input.requestKey, score, reason: artifactText(raw.reason, "reason", 10000, true), rubricEvidence: artifactList(raw.rubricEvidence, "rubricEvidence", 12, 1000) };
  }
  private artifactRequestKey(courseId: string, artifactType: string, requestKey: string) {
    return this.db.all<Record<string, any>>("SELECT id, content_json FROM ai_artifacts WHERE course_id = ? AND artifact_type = ? ORDER BY created_at DESC", [courseId, artifactType]).find((row) => {
      try { return parseJson(row.content_json, "contentJson")?.requestKey === requestKey; } catch { return false; }
    });
  }
  async generateArtifact(actor: Actor, courseId: string, input: { artifactType: "material" | "translation" | "feedback" | "suggested_score"; requestKey: string; materialId?: string; submissionAnswerId?: string; targetLocale?: string }, ai: AiService) {
    requireStaff(actor);
    if (!canManageCourse(this.db, actor, courseId)) throw new DomainError("not_found", "Course not found", 404);
    const requestKey = input.requestKey?.trim();
    if (!requestKey || requestKey.length > 128) throw new DomainError("invalid_input", "AI artifact requestKey is required");
    const existing = this.artifactRequestKey(courseId, input.artifactType, requestKey);
    if (existing) return this.getStaff(actor, existing.id);

    let materialId: string | undefined;
    let submissionAnswerId: string | undefined;
    let studentId: string | undefined;
    let purpose: "summary" | "translation" | "grading" | "feedback";
    let payload: Record<string, unknown>;
    let instruction: string;
    let maxScore: number | undefined;
    if (input.artifactType === "material" || input.artifactType === "translation") {
      if (!input.materialId) throw new DomainError("invalid_input", "materialId is required");
      const material = this.db.get<Record<string, any>>("SELECT m.id, m.status, m.title_zh, m.title_en, m.body_zh, m.body_en, u.course_id FROM materials m JOIN units u ON u.id = m.unit_id WHERE m.id = ?", [input.materialId]);
      if (!material || material.course_id !== courseId || material.status === "archived") throw new DomainError("invalid_reference", "Material and course must match");
      const sourceText = [material.title_zh, material.title_en, material.body_zh, material.body_en].filter((value) => typeof value === "string" && value.trim()).join("\n\n").slice(0, 30000);
      if (!sourceText) throw new DomainError("invalid_input", "Material has no text available for AI generation");
      materialId = material.id;
      if (input.artifactType === "material") {
        purpose = "summary";
        instruction = "Create an accurate educational material summary. Required fields: summaryZh (Traditional Chinese), summaryEn (English, may be null), keyPoints (one to twelve concise strings). Preserve uncertainty and do not invent facts.";
        payload = { materialTitle: material.title_zh, sourceText };
      } else {
        const targetLocale = input.targetLocale?.trim();
        if (!targetLocale || !/^[A-Za-z0-9][A-Za-z0-9-]{1,31}$/.test(targetLocale)) throw new DomainError("invalid_input", "A valid targetLocale is required");
        purpose = "translation";
        instruction = "Translate the supplied educational material faithfully. Required fields: sourceLocale (short locale or null), targetLocale, translatedText. Preserve code, URLs, markdown structure, and technical identifiers.";
        payload = { materialTitle: material.title_zh, sourceText, targetLocale };
      }
    } else {
      if (!input.submissionAnswerId) throw new DomainError("invalid_input", "submissionAnswerId is required");
      const answer = this.db.get<Record<string, any>>(`SELECT sa.id, sa.student_id, sa.answer_text, sa.answer_json, sa.question_snapshot_json, sa.assignment_id,
        a.course_id, a.title_zh AS assignment_title, q.prompt_zh, q.prompt_en, q.max_score, s.status AS submission_status
        FROM submission_answers sa JOIN assignments a ON a.id = sa.assignment_id JOIN submissions s ON s.id = sa.submission_id
        LEFT JOIN questions q ON q.id = sa.question_id WHERE sa.id = ?`, [input.submissionAnswerId]);
      if (!answer || answer.course_id !== courseId || answer.submission_status === "draft") throw new DomainError("invalid_reference", "Submission answer and course must match");
      const answerText = [answer.answer_text, answer.answer_json].filter((value) => typeof value === "string" && value.trim()).join("\n").slice(0, 30000);
      if (!answerText) throw new DomainError("invalid_input", "Submission answer has no content for AI generation");
      const snapshot = parseJson(answer.question_snapshot_json, "questionSnapshotJson") as Record<string, any>;
      maxScore = Number(answer.max_score ?? snapshot.maxScore ?? snapshot.max_score ?? 0);
      if (!Number.isFinite(maxScore) || maxScore < 0) throw new DomainError("invalid_reference", "Question max score is invalid");
      submissionAnswerId = answer.id;
      studentId = answer.student_id;
      const questionPrompt = String(answer.prompt_zh ?? snapshot.promptZh ?? snapshot.prompt_zh ?? "").slice(0, 12000);
      if (input.artifactType === "suggested_score") {
        purpose = "grading";
        instruction = "Suggest a fair score for the submitted answer using only the question and answer. Required fields: score (number from zero through maxScore), reason, rubricEvidence (zero to twelve concise strings). Never make the final grading decision.";
        payload = { assignmentTitle: answer.assignment_title, questionPrompt, answer: answerText, maxScore };
      } else {
        purpose = "feedback";
        instruction = "Write constructive teacher-reviewed feedback for the submitted answer. Required fields: feedbackZh (Traditional Chinese), feedbackEn (English, may be null), strengths (zero to ten strings), improvements (zero to ten strings), nextStep (may be null). Do not reveal or infer the student's identity.";
        payload = { assignmentTitle: answer.assignment_title, questionPrompt, answer: answerText, maxScore };
      }
    }
    const result = await ai.requestArtifact(actor, { requestKey, purpose, artifactType: input.artifactType, payload, instruction });
    if (!result.content) {
      const replay = this.artifactRequestKey(courseId, input.artifactType, requestKey);
      if (replay) return this.getStaff(actor, replay.id);
      throw new DomainError("ai_request_replay", "AI request was already completed; retrieve the existing artifact", 409);
    }
    const content = this.normalizeGeneratedArtifact(parseArtifactJson(result.content), { artifactType: input.artifactType, requestKey, targetLocale: input.targetLocale, maxScore });
    return this.create(actor, { artifactType: input.artifactType, courseId, content, studentId, materialId, submissionAnswerId });
  }
  create(actor: Actor, input: { artifactType: string; courseId: string; content: unknown; studentId?: string; materialId?: string; questionId?: string; submissionAnswerId?: string }) {
    requireStaff(actor);
    if (!ARTIFACT_TYPES.has(input.artifactType) || !canManageCourse(this.db, actor, input.courseId)) throw new DomainError("forbidden", "AI artifact scope denied", 403);
    const id = randomUUID();
    const time = iso(this.clock);
    this.db.run("INSERT INTO ai_artifacts (id, artifact_type, course_id, student_id, material_id, question_id, submission_answer_id, content_json, status, created_by_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?, ?)", [id, input.artifactType, input.courseId, input.studentId ?? null, input.materialId ?? null, input.questionId ?? null, input.submissionAnswerId ?? null, JSON.stringify(input.content), actor.id, time, time]);
    audit(this.db, actor.id, "ai.artifact_created", "ai_artifact", id, "success", { artifactType: input.artifactType, courseId: input.courseId });
    return this.getStaff(actor, id);
  }
  review(actor: Actor, id: string, decision: "approved" | "rejected", comment?: string) {
    requireStaff(actor);
    const artifact = this.db.get<Record<string, any>>("SELECT * FROM ai_artifacts WHERE id = ?", [id]);
    if (!artifact || !canManageCourse(this.db, actor, artifact.course_id)) throw new DomainError("forbidden", "AI artifact scope denied", 403);
    if (artifact.status !== "pending_review") throw new DomainError("invalid_review_transition", "Artifact is not awaiting review");
    const time = iso(this.clock);
    this.db.run("UPDATE ai_artifacts SET status = ?, reviewed_by_id = ?, review_comment = ?, reviewed_at = ?, updated_at = ? WHERE id = ?", [decision, actor.id, comment ?? null, time, time, id]);
    audit(this.db, actor.id, "ai.artifact_reviewed", "ai_artifact", id, "success", { decision });
    return this.getStaff(actor, id);
  }
  publish(actor: Actor, id: string) {
    requireStaff(actor);
    const artifact = this.db.get<Record<string, any>>("SELECT * FROM ai_artifacts WHERE id = ?", [id]);
    if (!artifact || !canManageCourse(this.db, actor, artifact.course_id)) throw new DomainError("forbidden", "AI artifact scope denied", 403);
    if (artifact.artifact_type === "question") throw new DomainError("authoring_materialization_required", "Question artifacts must be materialized after approval", 409);
    if (artifact.status !== "approved") throw new DomainError("invalid_review_transition", "Only approved artifacts can be published");
    const time = iso(this.clock);
    this.db.run("UPDATE ai_artifacts SET status = 'published', published_at = ?, updated_at = ? WHERE id = ?", [time, time, id]);
    audit(this.db, actor.id, "ai.artifact_published", "ai_artifact", id, "success");
    return this.getStaff(actor, id);
  }
  getStaff(actor: Actor, id: string) {
    requireStaff(actor);
    const row = this.db.get<Record<string, any>>("SELECT * FROM ai_artifacts WHERE id = ?", [id]);
    if (!row || !canManageCourse(this.db, actor, row.course_id)) throw new DomainError("not_found", "AI artifact not found", 404);
    return { ...row, content: parseJson(row.content_json, "contentJson") };
  }
  getStudent(actor: Actor, id: string) {
    if (actor.role !== "student") throw new DomainError("forbidden", "Student permission required", 403);
    const row = this.db.get<Record<string, any>>("SELECT id, artifact_type, course_id, student_id, content_json, status, published_at FROM ai_artifacts WHERE id = ? AND status = 'published' AND artifact_type IN ('material', 'translation', 'feedback')", [id]);
    if (!row || !canViewCourse(this.db, actor, row.course_id) || (row.student_id && row.student_id !== actor.id)) throw new DomainError("not_found", "AI artifact not found", 404);
    return { id: row.id, artifactType: row.artifact_type, courseId: row.course_id, content: parseJson(row.content_json, "contentJson"), publishedAt: row.published_at };
  }
  materializeQuestion(actor: Actor, id: string) {
    requireStaff(actor);
    const artifact = this.db.get<Record<string, any>>("SELECT * FROM ai_artifacts WHERE id = ? AND artifact_type = 'question'", [id]);
    if (!artifact || !canManageCourse(this.db, actor, artifact.course_id)) throw new DomainError("not_found", "AI artifact not found", 404);
    const questions = new QuestionService(this.db, this.clock);
    if (artifact.question_id) return { artifact: this.getStaff(actor, id), question: questions.getStaffQuestion(actor, artifact.question_id) };
    if (artifact.status !== "approved") throw new DomainError("invalid_review_transition", "Only approved question artifacts can be materialized", 409);
    const content = parseJson(artifact.content_json, "contentJson") as Record<string, any>;
    const normalized = this.normalizeQuestionContent(content, {
      type: typeof content.type === "string" ? content.type : "",
      concepts: content.requiredConcepts ?? [],
      maxScore: typeof content.maxScore === "number" ? content.maxScore : undefined,
      unitId: typeof content.unitId === "string" ? content.unitId : undefined,
    });
    if (normalized.unitId) {
      const unit = this.db.get<{ course_id: string; status: string }>("SELECT course_id, status FROM units WHERE id = ?", [normalized.unitId]);
      if (!unit || unit.course_id !== artifact.course_id || unit.status === "archived") throw new DomainError("invalid_reference", "Question unit and course must match");
    }
    let question: Record<string, any> | null = null;
    this.db.transaction(() => {
      const current = this.db.get<{ question_id: string | null }>("SELECT question_id FROM ai_artifacts WHERE id = ?", [id]);
      if (current?.question_id) { question = questions.getStaffQuestion(actor, current.question_id); return; }
      const created = questions.createQuestion(actor, {
        courseId: artifact.course_id, unitId: normalized.unitId ?? undefined, type: normalized.type, titleZh: normalized.titleZh ?? "", titleEn: normalized.titleEn ?? undefined,
        promptZh: normalized.promptZh ?? "", promptEn: normalized.promptEn ?? undefined, optionsJson: normalized.optionsJson, answerKeyJson: normalized.answerKeyJson,
        explanationZh: normalized.explanationZh ?? undefined, explanationEn: normalized.explanationEn ?? undefined, starterCode: normalized.starterCode ?? undefined,
        solutionCode: normalized.solutionCode ?? undefined, requiredConceptsJson: normalized.requiredConcepts, maxScore: normalized.maxScore,
      });
      if (!created) throw new DomainError("internal_error", "Materialized question was not created", 500);
      question = created;
      for (const test of normalized.testCases ?? []) questions.addTestCase(actor, (question as Record<string, any>).id, {
        visibility: test.visibility, label: test.label ?? undefined, inputJson: test.inputJson, expectedOutput: test.expectedOutput,
        comparisonMode: test.comparisonMode as "exact" | "trimmed" | "numeric_tolerance", tolerance: test.tolerance ?? undefined,
        weight: test.weight ?? undefined, position: test.position ?? undefined, timeLimitMs: test.timeLimitMs ?? undefined, memoryLimitMb: test.memoryLimitMb ?? undefined,
      });
      const time = iso(this.clock);
      this.db.run("UPDATE ai_artifacts SET question_id = ?, status = 'published', published_at = ?, updated_at = ? WHERE id = ? AND question_id IS NULL", [(question as Record<string, any>).id, time, time, id]);
      audit(this.db, actor.id, "ai.question_materialized", "ai_artifact", id, "success", { questionId: (question as Record<string, any>).id });
    });
    return { artifact: this.getStaff(actor, id), question };
  }
  listStaff(actor: Actor, courseId: string) {
    requireStaff(actor);
    if (!canManageCourse(this.db, actor, courseId)) throw new DomainError("forbidden", "AI artifact scope denied", 403);
    return this.db.all("SELECT id, artifact_type, course_id, student_id, material_id, question_id, submission_answer_id, status, created_by_id, reviewed_by_id, review_comment, reviewed_at, published_at, created_at, updated_at FROM ai_artifacts WHERE course_id = ? ORDER BY created_at DESC", [courseId]);
  }
  confirmSuggestedScore(actor: Actor, id: string) {
    requireStaff(actor);
    const artifact = this.db.get<Record<string, any>>("SELECT * FROM ai_artifacts WHERE id = ? AND artifact_type = 'suggested_score' AND status IN ('approved', 'published')", [id]);
    if (!artifact || !artifact.submission_answer_id || !canManageCourse(this.db, actor, artifact.course_id)) throw new DomainError("forbidden", "Suggested score scope denied", 403);
    const content = parseJson(artifact.content_json, "contentJson") as Record<string, unknown>;
    if (typeof content.score !== "number" || content.score < 0) throw new DomainError("invalid_input", "Suggested score is invalid");
    this.db.run("UPDATE submission_answers SET ai_suggested_score = ?, updated_at = ? WHERE id = ?", [content.score, iso(this.clock), artifact.submission_answer_id]);
    audit(this.db, actor.id, "ai.suggested_score_confirmed", "ai_artifact", id, "success", { submissionAnswerId: artifact.submission_answer_id });
    return { artifactId: id, aiSuggestedScore: content.score, finalScore: this.db.get<{ final_score: number | null }>("SELECT final_score FROM submission_answers WHERE id = ?", [artifact.submission_answer_id])?.final_score ?? null };
  }
}
