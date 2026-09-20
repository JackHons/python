/* eslint-disable @typescript-eslint/no-explicit-any -- report rows are database projections. */
import type { Actor } from "../education.ts";
import type { LocalDatabase } from "../db.ts";
import { DomainError } from "../errors.ts";
import { AuditService } from "../audit/service.ts";

const REPORT_VERSION = "v1";
const TIMEZONE = "Asia/Macau";
const STAFF = new Set(["admin", "teacher"]);
type Filters = { courseId?: string; classId?: string; studentId?: string };

function iso(clock: () => Date) { return clock().toISOString(); }
function requireActive(db: LocalDatabase, actor: Actor) {
  const user = db.get<{ role: string; status: string }>("SELECT role, status FROM users WHERE id = ?", [actor.id]);
  if (!user || user.role !== actor.role || user.status !== "active") throw new DomainError("unauthorized", "Active session required", 401);
}
function canManageCourse(db: LocalDatabase, actor: Actor, courseId: string) {
  if (actor.role === "admin") return true;
  if (actor.role !== "teacher") return false;
  return Boolean(db.get("SELECT 1 FROM courses c WHERE c.id = ? AND (c.owner_teacher_id = ? OR EXISTS (SELECT 1 FROM course_class_assignments cca JOIN class_memberships cm ON cm.class_id = cca.class_id WHERE cca.course_id = c.id AND cm.user_id = ? AND cm.member_role = 'teacher' AND cm.status = 'active'))", [courseId, actor.id, actor.id]));
}
function classScope(db: LocalDatabase, actor: Actor, classId: string) {
  if (actor.role === "admin") return Boolean(db.get("SELECT 1 FROM classes WHERE id = ? AND status = 'active'", [classId]));
  return actor.role === "teacher" && Boolean(db.get("SELECT 1 FROM class_memberships WHERE class_id = ? AND user_id = ? AND member_role = 'teacher' AND status = 'active'", [classId, actor.id]));
}

export type Report = {
  reportVersion: string;
  snapshotAt: string;
  timezone: string;
  scope: { role: string; courseId: string | null; classId: string | null; studentId: string | null };
  data: Record<string, unknown>;
  missingData: string[];
};

export class AnalyticsService {
  private readonly db: LocalDatabase;
  private readonly clock: () => Date;
  private readonly audit: AuditService;
  constructor(db: LocalDatabase, clock: () => Date = () => new Date()) { this.db = db; this.clock = clock; this.audit = new AuditService(db); }

  private scope(actor: Actor, filters: Filters = {}) {
    requireActive(this.db, actor);
    if (!STAFF.has(actor.role) && actor.role !== "student") throw new DomainError("forbidden", "Analytics permission required", 403);
    if (actor.role === "student") {
      if (filters.studentId && filters.studentId !== actor.id) throw new DomainError("forbidden", "Students can only view their own analytics", 403);
      if (filters.courseId && !this.db.get("SELECT 1 FROM course_enrollments WHERE course_id = ? AND student_id = ? AND status = 'active'", [filters.courseId, actor.id])) throw new DomainError("forbidden", "You are not enrolled in this course", 403);
      return { courseId: filters.courseId ?? null, classId: null, studentId: actor.id };
    }
    if (filters.courseId && !canManageCourse(this.db, actor, filters.courseId)) throw new DomainError("forbidden", "You cannot view this course analytics", 403);
    if (filters.classId && !classScope(this.db, actor, filters.classId)) throw new DomainError("forbidden", "You cannot view this class analytics", 403);
    if (actor.role === "teacher" && !filters.courseId && !filters.classId) throw new DomainError("invalid_scope", "A teacher must provide a courseId or classId");
    if (actor.role === "teacher" && filters.studentId) {
      const inScope = filters.courseId
        ? Boolean(this.db.get("SELECT 1 FROM course_enrollments WHERE course_id = ? AND student_id = ? AND status = 'active'", [filters.courseId, filters.studentId]))
        : Boolean(this.db.get("SELECT 1 FROM class_memberships WHERE class_id = ? AND user_id = ? AND member_role = 'student' AND status = 'active'", [filters.classId, filters.studentId]));
      if (!inScope) throw new DomainError("forbidden", "Student is outside your teaching scope", 403);
    }
    return { courseId: filters.courseId ?? null, classId: filters.classId ?? null, studentId: filters.studentId ?? null };
  }

  private courseWhere(actor: Actor, scope: ReturnType<AnalyticsService["scope"]>, alias = "c") {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (scope.courseId) { conditions.push(`${alias}.id = ?`); params.push(scope.courseId); }
    if (scope.classId) {
      conditions.push(`EXISTS (SELECT 1 FROM course_class_assignments scoped_cca WHERE scoped_cca.course_id = ${alias}.id AND scoped_cca.class_id = ?)`);
      params.push(scope.classId);
      conditions.push("EXISTS (SELECT 1 FROM class_memberships scoped_cm_student WHERE scoped_cm_student.class_id = ? AND scoped_cm_student.user_id = ce.student_id AND scoped_cm_student.member_role = 'student' AND scoped_cm_student.status = 'active')");
      params.push(scope.classId);
    }
    if (actor.role === "teacher") { conditions.push(`(${alias}.owner_teacher_id = ? OR EXISTS (SELECT 1 FROM course_class_assignments teacher_cca JOIN class_memberships teacher_cm ON teacher_cm.class_id = teacher_cca.class_id WHERE teacher_cca.course_id = ${alias}.id AND teacher_cm.user_id = ? AND teacher_cm.member_role = 'teacher' AND teacher_cm.status = 'active'))`); params.push(actor.id, actor.id); }
    if (actor.role === "student") { conditions.push("ce.student_id = ? AND ce.status = 'active'"); params.push(actor.id); }
    if (scope.studentId) { conditions.push("ce.student_id = ? AND ce.status = 'active'"); params.push(scope.studentId); }
    return { sql: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", params };
  }

  private report(actor: Actor, filters: Filters, data: Record<string, unknown>, missingData: string[] = []): Report {
    const scope = this.scope(actor, filters);
    this.audit.record(actor, { action: "analytics.query", entityType: "analytics_report", metadata: { reportVersion: REPORT_VERSION, scope } });
    return { reportVersion: REPORT_VERSION, snapshotAt: iso(this.clock), timezone: TIMEZONE, scope: { role: actor.role, courseId: scope.courseId, classId: scope.classId, studentId: scope.studentId }, data, missingData };
  }

  overview(actor: Actor, filters: Filters = {}) {
    const scope = this.scope(actor, filters);
    const where = this.courseWhere(actor, scope);
    const rows = this.db.all<Record<string, any>>(`SELECT c.id AS course_id, c.title_zh, ce.student_id, u.chinese_name, u.english_name, COUNT(DISTINCT CASE WHEN a.status IN ('published', 'closed') THEN a.id END) AS assignments_total, COUNT(DISTINCT CASE WHEN a.status IN ('published', 'closed') AND s.status IN ('submitted', 'grading', 'graded', 'returned') THEN a.id END) AS assignments_completed, COALESCE(AVG(g.final_score), 0) AS average_score, COUNT(s.id) AS attempt_count, COALESCE(SUM(ls.active_seconds), 0) AS learning_seconds FROM courses c JOIN course_enrollments ce ON ce.course_id = c.id AND ce.status = 'active' JOIN users u ON u.id = ce.student_id LEFT JOIN assignments a ON a.course_id = c.id LEFT JOIN submissions s ON s.assignment_id = a.id AND s.student_id = ce.student_id LEFT JOIN grades g ON g.submission_id = s.id LEFT JOIN learning_sessions ls ON ls.course_id = c.id AND ls.student_id = ce.student_id ${where.sql} GROUP BY c.id, ce.student_id ORDER BY c.id, ce.student_id`, where.params);
    return this.report(actor, filters, { students: rows.map((row) => ({ courseId: row.course_id, courseTitle: row.title_zh, studentId: row.student_id, chineseName: STAFF.has(actor.role) ? row.chinese_name : undefined, englishName: STAFF.has(actor.role) ? row.english_name : undefined, assignmentsTotal: Number(row.assignments_total), assignmentsCompleted: Number(row.assignments_completed), completionRate: Number(row.assignments_total) ? Number(row.assignments_completed) / Number(row.assignments_total) : 0, averageScore: Number(row.average_score), attemptCount: Number(row.attempt_count), learningSeconds: Number(row.learning_seconds) })) });
  }

  questionAccuracy(actor: Actor, filters: Filters = {}) {
    const scope = this.scope(actor, filters);
    const where = this.courseWhere(actor, scope);
    const rows = this.db.all<Record<string, any>>(`SELECT q.id AS question_id, q.course_id, q.title_zh, COUNT(DISTINCT sa.id) AS attempts, SUM(CASE WHEN sa.final_score >= json_extract(sa.question_snapshot_json, '$.maxScore') THEN 1 ELSE 0 END) AS correct, COUNT(DISTINCT tr.id) AS code_tests, SUM(CASE WHEN tr.status = 'passed' THEN 1 ELSE 0 END) AS passed_tests FROM courses c JOIN course_enrollments ce ON ce.course_id = c.id AND ce.status = 'active' JOIN questions q ON q.course_id = c.id LEFT JOIN submission_answers sa ON sa.question_id = q.id AND sa.student_id = ce.student_id LEFT JOIN code_runs cr ON cr.submission_answer_id = sa.id LEFT JOIN test_results tr ON tr.code_run_id = cr.id ${where.sql} GROUP BY q.id ORDER BY q.course_id, q.id`, where.params);
    return this.report(actor, filters, { questions: rows.map((row) => ({ questionId: row.question_id, courseId: row.course_id, title: row.title_zh, attempts: Number(row.attempts), correct: Number(row.correct ?? 0), accuracy: Number(row.attempts) ? Number(row.correct ?? 0) / Number(row.attempts) : null, codeTests: Number(row.code_tests), passedTests: Number(row.passed_tests ?? 0) })) });
  }

  commonErrors(actor: Actor, filters: Filters = {}) {
    const scope = this.scope(actor, filters);
    const where = this.courseWhere(actor, scope, "c");
    const rows = this.db.all<Record<string, any>>(`SELECT q.id AS question_id, q.title_zh, tr.status, COALESCE(tr.error_message, cr.stderr, 'test_failed') AS error_code, COUNT(*) AS occurrences FROM courses c JOIN course_enrollments ce ON ce.course_id = c.id AND ce.status = 'active' JOIN assignments a ON a.course_id = c.id JOIN submissions s ON s.assignment_id = a.id JOIN submission_answers sa ON sa.submission_id = s.id AND sa.student_id = ce.student_id JOIN questions q ON q.id = sa.question_id JOIN code_runs cr ON cr.submission_answer_id = sa.id JOIN test_results tr ON tr.code_run_id = cr.id WHERE tr.status IN ('failed', 'timeout', 'error') ${where.sql ? `AND ${where.sql.slice(6)}` : ""} GROUP BY q.id, tr.status, error_code ORDER BY occurrences DESC`, where.params);
    return this.report(actor, filters, { errors: rows.map((row) => ({ questionId: row.question_id, title: row.title_zh, status: row.status, errorCode: String(row.error_code).slice(0, 200), occurrences: Number(row.occurrences) })) }, ["Only persisted runner/test-result errors are available; free-text classroom misconceptions are not captured."]);
  }

  aiUsage(actor: Actor, filters: Filters = {}) {
    const scope = this.scope(actor, filters);
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (actor.role === "student") { conditions.push("au.user_id = ?"); params.push(actor.id); }
    if (scope.studentId) { conditions.push("au.user_id = ?"); params.push(scope.studentId); }
    if (scope.courseId) { conditions.push("ac.course_id = ?"); params.push(scope.courseId); }
    if (scope.classId) {
      conditions.push("EXISTS (SELECT 1 FROM course_class_assignments xcca WHERE xcca.course_id = ac.course_id AND xcca.class_id = ?)"); params.push(scope.classId);
      conditions.push("EXISTS (SELECT 1 FROM class_memberships xcm WHERE xcm.class_id = ? AND xcm.user_id = au.user_id AND xcm.member_role = 'student' AND xcm.status = 'active')"); params.push(scope.classId);
    }
    if (actor.role === "teacher") { conditions.push("EXISTS (SELECT 1 FROM courses scoped_c JOIN course_class_assignments scoped_cca ON scoped_cca.course_id = scoped_c.id JOIN class_memberships scoped_cm ON scoped_cm.class_id = scoped_cca.class_id WHERE scoped_c.id = ac.course_id AND (scoped_c.owner_teacher_id = ? OR (scoped_cm.user_id = ? AND scoped_cm.member_role = 'teacher' AND scoped_cm.status = 'active'))) "); params.push(actor.id, actor.id); }
    const rows = this.db.all<Record<string, any>>(`SELECT au.user_id, ac.course_id, au.purpose, au.status, COUNT(*) AS requests, SUM(au.input_tokens + au.output_tokens) AS tokens FROM ai_usage au LEFT JOIN ai_conversations ac ON ac.id = au.conversation_id WHERE ${conditions.length ? conditions.join(" AND ") : "1=1"} GROUP BY au.user_id, ac.course_id, au.purpose, au.status ORDER BY au.user_id, au.purpose`, params);
    return this.report(actor, filters, { usage: rows.map((row) => ({ userId: actor.role === "student" ? undefined : row.user_id, courseId: row.course_id, purpose: row.purpose, status: row.status, requests: Number(row.requests), tokens: Number(row.tokens ?? 0) })) }, ["AI usage without a conversation/course is retained but excluded from teacher course-scoped rows."]);
  }

  codeHistory(actor: Actor, filters: Filters = {}) {
    const scope = this.scope(actor, filters);
    const where = this.courseWhere(actor, scope);
    const rows = this.db.all<Record<string, any>>(`SELECT cs.student_id, cs.submission_answer_id, cs.sequence_number, cs.source, cs.sha256, cs.pasted_character_count, cs.created_at, cr.id AS run_id, cr.status AS run_status, cr.duration_ms FROM courses c JOIN course_enrollments ce ON ce.course_id = c.id AND ce.status = 'active' JOIN submission_answers sa ON sa.student_id = ce.student_id JOIN submissions s ON s.id = sa.submission_id JOIN assignments a ON a.id = s.assignment_id AND a.course_id = c.id JOIN code_snapshots cs ON cs.submission_answer_id = sa.id LEFT JOIN code_runs cr ON cr.snapshot_id = cs.id ${where.sql} ORDER BY cs.created_at, cs.sequence_number`, where.params);
    return this.report(actor, filters, { history: rows.map((row) => ({ studentId: actor.role === "student" ? undefined : row.student_id, submissionAnswerId: row.submission_answer_id, sequence: Number(row.sequence_number), source: row.source, sha256: row.sha256, pastedCharacterCount: Number(row.pasted_character_count), createdAt: row.created_at, runId: row.run_id, runStatus: row.run_status, durationMs: row.duration_ms })) });
  }

  learningTime(actor: Actor, filters: Filters = {}) {
    const scope = this.scope(actor, filters);
    const where = this.courseWhere(actor, scope);
    const rows = this.db.all<Record<string, any>>(`SELECT ls.student_id, ls.course_id, ls.assignment_id, ls.started_at, ls.ended_at, ls.active_seconds FROM courses c JOIN course_enrollments ce ON ce.course_id = c.id AND ce.status = 'active' JOIN learning_sessions ls ON ls.course_id = c.id AND ls.student_id = ce.student_id ${where.sql} ORDER BY ls.started_at`, where.params);
    return this.report(actor, filters, { sessions: rows.map((row) => ({ studentId: actor.role === "student" ? undefined : row.student_id, courseId: row.course_id, assignmentId: row.assignment_id, startedAt: row.started_at, endedAt: row.ended_at, activeSeconds: Number(row.active_seconds) })) });
  }

  compareCourses(actor: Actor, filters: Filters = {}) {
    const scope = this.scope(actor, filters);
    const where = this.courseWhere(actor, scope);
    const rows = this.db.all<Record<string, any>>(`SELECT c.id AS course_id, c.title_zh, COUNT(DISTINCT ce.student_id) AS students, COUNT(DISTINCT CASE WHEN s.status != 'draft' THEN s.id END) AS submissions, COALESCE(AVG(g.final_score), 0) AS average_score, COALESCE(SUM(ls.active_seconds), 0) AS learning_seconds FROM courses c JOIN course_enrollments ce ON ce.course_id = c.id AND ce.status = 'active' LEFT JOIN assignments a ON a.course_id = c.id LEFT JOIN submissions s ON s.assignment_id = a.id AND s.student_id = ce.student_id LEFT JOIN grades g ON g.submission_id = s.id LEFT JOIN learning_sessions ls ON ls.course_id = c.id AND ls.student_id = ce.student_id ${where.sql} GROUP BY c.id ORDER BY c.id`, where.params);
    return this.report(actor, filters, { courses: rows.map((row) => ({ courseId: row.course_id, title: row.title_zh, students: Number(row.students), submissions: Number(row.submissions), averageScore: Number(row.average_score), learningSeconds: Number(row.learning_seconds) })) });
  }
}
