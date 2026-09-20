import { randomUUID } from "node:crypto";
import type { Actor } from "./education.ts";
import type { LocalDatabase } from "./db.ts";
import { DomainError } from "./errors.ts";

const EVENT_TYPES = new Set(["tab_hidden", "tab_visible", "route_blocked", "focus_lost"]);
const STAFF = new Set(["admin", "teacher"]);

export function activeExam(database: LocalDatabase, studentId: string, courseId: string) {
  return database.get<{ assignment_id: string; submission_id: string; title_zh: string }>(
    `SELECT a.id AS assignment_id, s.id AS submission_id, a.title_zh
       FROM assignments a JOIN submissions s ON s.assignment_id = a.id
      WHERE a.course_id = ? AND a.kind = 'exam' AND a.exam_mode = 1
        AND s.student_id = ? AND s.status = 'draft'
      ORDER BY s.created_at DESC LIMIT 1`,
    [courseId, studentId],
  );
}

export function hasActiveExam(database: LocalDatabase, studentId: string) {
  return Boolean(database.get("SELECT 1 FROM assignments a JOIN submissions s ON s.assignment_id = a.id WHERE a.kind = 'exam' AND a.exam_mode = 1 AND s.student_id = ? AND s.status = 'draft' LIMIT 1", [studentId]));
}

export function assertExamResourceAccess(database: LocalDatabase, actor: Actor, courseId: string) {
  if (actor.role === "student" && activeExam(database, actor.id, courseId)) {
    throw new DomainError("exam_mode_restriction", "This course resource is unavailable during an active exam", 423);
  }
}

function canManageCourse(database: LocalDatabase, actor: Actor, courseId: string) {
  if (actor.role === "admin") return true;
  if (actor.role !== "teacher") return false;
  return Boolean(database.get(
    `SELECT 1 FROM courses c WHERE c.id = ? AND (c.owner_teacher_id = ? OR EXISTS (
      SELECT 1 FROM course_class_assignments cca JOIN class_memberships cm ON cm.class_id = cca.class_id
       WHERE cca.course_id = c.id AND cm.user_id = ? AND cm.member_role = 'teacher' AND cm.status = 'active'))`,
    [courseId, actor.id, actor.id],
  ));
}

export class ExamService {
  private readonly db: LocalDatabase;
  constructor(db: LocalDatabase) { this.db = db; }

  recordEvent(actor: Actor, submissionId: string, input: { eventType: string; idempotencyKey: string; pagePath?: string; payload?: unknown }) {
    if (actor.role !== "student") throw new DomainError("forbidden", "Student permission required", 403);
    const eventType = input.eventType?.trim();
    const idempotencyKey = input.idempotencyKey?.trim();
    if (!EVENT_TYPES.has(eventType)) throw new DomainError("invalid_input", "Exam event type is invalid");
    if (!idempotencyKey || idempotencyKey.length > 128) throw new DomainError("invalid_input", "Exam event idempotency key is required");
    const submission = this.db.get<{ id: string; assignment_id: string; student_id: string; status: string; exam_mode: number }>(
      `SELECT s.id, s.assignment_id, s.student_id, s.status, a.exam_mode
         FROM submissions s JOIN assignments a ON a.id = s.assignment_id WHERE s.id = ?`,
      [submissionId],
    );
    if (!submission || submission.student_id !== actor.id || submission.exam_mode !== 1) throw new DomainError("not_found", "Exam submission not found", 404);
    if (["returned", "cancelled"].includes(submission.status)) throw new DomainError("submission_locked", "Exam submission is closed", 409);
    const pagePath = input.pagePath?.trim() || null;
    if (pagePath && (pagePath.length > 256 || !pagePath.startsWith("/"))) throw new DomainError("invalid_input", "Exam event pagePath is invalid");
    let payload = input.payload ?? {};
    try { payload = JSON.parse(JSON.stringify(payload)); } catch { throw new DomainError("invalid_input", "Exam event payload must be JSON serializable"); }
    const payloadJson = JSON.stringify(payload);
    if (payloadJson.length > 4000) throw new DomainError("invalid_input", "Exam event payload is too large");
    const existing = this.db.get<Record<string, unknown>>("SELECT * FROM exam_events WHERE student_id = ? AND submission_id = ? AND idempotency_key = ?", [actor.id, submissionId, idempotencyKey]);
    if (existing) return { event: existing, replay: true };
    const id = randomUUID();
    try {
      this.db.run("INSERT INTO exam_events (id, assignment_id, submission_id, student_id, event_type, page_path, payload_json, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [id, submission.assignment_id, submissionId, actor.id, eventType, pagePath, payloadJson, idempotencyKey]);
    } catch {
      const raced = this.db.get<Record<string, unknown>>("SELECT * FROM exam_events WHERE student_id = ? AND submission_id = ? AND idempotency_key = ?", [actor.id, submissionId, idempotencyKey]);
      if (raced) return { event: raced, replay: true };
      throw new DomainError("conflict", "Exam event conflicted; retry with the same key", 409);
    }
    return { event: this.db.get("SELECT * FROM exam_events WHERE id = ?", [id]), replay: false };
  }

  listEvents(actor: Actor, submissionId: string) {
    const submission = this.db.get<{ assignment_id: string; course_id: string; student_id: string }>("SELECT s.assignment_id, a.course_id, s.student_id FROM submissions s JOIN assignments a ON a.id = s.assignment_id WHERE s.id = ? AND a.exam_mode = 1", [submissionId]);
    if (!submission) throw new DomainError("not_found", "Exam submission not found", 404);
    if (actor.role === "student" && submission.student_id !== actor.id) throw new DomainError("not_found", "Exam submission not found", 404);
    if (STAFF.has(actor.role) && !canManageCourse(this.db, actor, submission.course_id)) throw new DomainError("not_found", "Exam submission not found", 404);
    return this.db.all("SELECT id, assignment_id, submission_id, student_id, event_type, page_path, payload_json, idempotency_key, created_at FROM exam_events WHERE submission_id = ? ORDER BY created_at, id", [submissionId]);
  }
}
