import { randomUUID } from "node:crypto";
import type { Actor } from "../education.ts";
import type { LocalDatabase } from "../db.ts";
import { DomainError } from "../errors.ts";

const SECRET_KEY = /(password|passwd|token|api[_-]?key|secret|authorization|cookie|hidden|answer|solution|prompt|code)/i;
const SECRET_VALUE = /(sk-[A-Za-z0-9_-]{12,}|bearer\s+[A-Za-z0-9._-]+|eyJ[A-Za-z0-9._-]{20,})/i;

export function redactAuditValue(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") {
    if (SECRET_VALUE.test(value)) return "[redacted]";
    return value.replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted]").replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
  }
  if (Array.isArray(value)) return value.map((item) => redactAuditValue(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactAuditValue(childValue, childKey)]));
  }
  return value;
}

export function redactAuditMetadata(metadata: Record<string, unknown> = {}) {
  return redactAuditValue(metadata) as Record<string, unknown>;
}

export class AuditService {
  private readonly db: LocalDatabase;
  constructor(db: LocalDatabase) { this.db = db; }

  record(actor: Actor | null, input: { action: string; entityType: string; entityId?: string | null; result?: "success" | "denied" | "failure"; metadata?: Record<string, unknown>; correlationId?: string; requestId?: string; ipHash?: string }) {
    const correlationId = input.correlationId?.trim() || randomUUID();
    const metadata = redactAuditMetadata({ ...(input.metadata ?? {}), correlationId });
    this.db.run("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, result, metadata_json, request_id, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [randomUUID(), actor?.id ?? null, input.action, input.entityType, input.entityId ?? null, input.result ?? "success", JSON.stringify(metadata), correlationId, input.ipHash ?? null]);
    return { correlationId };
  }

  list(actor: Actor, options: { action?: string; correlationId?: string; limit?: number } = {}) {
    const user = this.db.get<{ role: string; status: string }>("SELECT role, status FROM users WHERE id = ?", [actor.id]);
    if (!user || user.role !== actor.role || user.status !== "active") throw new DomainError("unauthorized", "Active session required", 401);
    if (actor.role !== "admin") throw new DomainError("forbidden", "Administrator permission required", 403);
    const limit = Math.max(1, Math.min(500, options.limit ?? 100));
    return this.db.all("SELECT id, actor_id, action, entity_type, entity_id, result, metadata_json, request_id, ip_hash, created_at FROM audit_logs WHERE (? IS NULL OR action = ?) AND (? IS NULL OR request_id = ?) ORDER BY created_at DESC LIMIT ?", [options.action ?? null, options.action ?? null, options.correlationId ?? null, options.correlationId ?? null, limit]);
  }
}

